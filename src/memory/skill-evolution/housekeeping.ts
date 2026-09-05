/**
 * PLAN-42 Phase 4+5 housekeeping for one evolution iteration: validation
 * gate, PLAN-43 attestation sweep/exchange, wiki lint, semantic lint, P2P
 * publish. Split out of evolution-pass.ts (500-line cap).
 */

import type { EvolutionPassDeps } from "./evolution-pass.js";
import type { WikiStoreOptions } from "./wiki-store.js";
import { pubkeyId } from "../../commerce/envelope.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { syncAttestations } from "../../services/attestation-client.js";
import { CommerceReputationLedger } from "../commerce-reputation.js";
import { ContributorStatusLedger } from "../contributor-status.js";
import { SellerBondLedger } from "../seller-bond-ledger.js";
import { runAttestationSweep, skillContentSha256 } from "./attestation.js";
import { publishEligibleEvolvedSkills, type PublishSweepResult } from "./p2p-publish.js";
import { creditSkillReads } from "./skill-reads.js";
import { runValidationGate, type ValidationGateOutcome } from "./validation-gate.js";
import { runWikiLint, type WikiLintResult } from "./wiki-lint.js";
import {
  readSemanticLintState,
  runSemanticLint,
  type SemanticLintResult,
} from "./wiki-semantic-lint.js";

const log = createSubsystemLogger("skill-evolution/housekeeping");

/**
 * Validation gate (settles held + new proposals), wiki lint, and the P2P
 * publish sweep. Runs on every iteration attempt — held proposals and
 * publish eligibility ripen with time even when no new traces arrive.
 */
export async function runHousekeeping(
  deps: EvolutionPassDeps,
  storeOpts: WikiStoreOptions,
): Promise<{
  validation?: ValidationGateOutcome[];
  lint?: WikiLintResult;
  semanticLint?: SemanticLintResult;
  publish?: PublishSweepResult;
  attestation?: { attested: number; skipped: number; held: number };
  /** PLAN-44 Phase 5a: live-skill reads credited from the journal this pass. */
  skillReads?: { scannedRuns: number; credited: number };
}> {
  // PLAN-44 Phase 5a: the usage signal. Runs first so the lifecycle
  // counters the validation gate's regression check reads are current.
  let skillReads: { scannedRuns: number; credited: number } | undefined;
  if (deps.journal) {
    try {
      const r = await creditSkillReads({
        journal: deps.journal,
        db: deps.db ?? null,
        ...(storeOpts.configDir ? { storeOpts } : {}),
        ...(deps.workspaceDir ? { workspaceDir: deps.workspaceDir } : {}),
      });
      skillReads = { scannedRuns: r.scannedRuns, credited: r.credited };
    } catch (err) {
      log.warn(`skill-read crediting failed: ${String(err)}`);
    }
  }
  const validation = await runValidationGate({
    journal: deps.journal,
    llmCall: deps.llmCall,
    ...(storeOpts.configDir ? { storeOpts } : {}),
    ...(deps.validationMode ? { mode: deps.validationMode } : {}),
    ...(typeof deps.trialsPerTask === "number" ? { trialsPerTask: deps.trialsPerTask } : {}),
    ...(deps.agentTurn ? { agentTurn: deps.agentTurn } : {}),
    ...(deps.maxActiveEvolved ? { maxActiveEvolved: deps.maxActiveEvolved } : {}),
    ...(deps.modelTag ? { modelTag: deps.modelTag } : {}),
    ...(typeof deps.validationBudgetMinutes === "number"
      ? { validationBudgetMinutes: deps.validationBudgetMinutes }
      : {}),
    ...(deps.descriptionRepair === false ? { descriptionRepair: false } : {}),
    iteration: deps.cycleId ?? new Date().toISOString().slice(0, 10),
  });
  // PLAN-43 Phase 3: attest peer skills on our own corpus (tasks mode only:
  // it needs the real-rollout executor). Best-effort, bounded per pass.
  let attestation: { attested: number; skipped: number; held: number } | undefined;
  // The SWEEP needs tasks-mode rollouts; the fraud pass and the exchange
  // need only the db and the key, and run in every validation mode.
  if (deps.db && deps.attestKeyPair) {
    if (deps.peerAgentTurn) {
      try {
        attestation = await runAttestationSweep({
          db: deps.db,
          agentTurn: deps.peerAgentTurn,
          keyPair: deps.attestKeyPair,
          ...(storeOpts.configDir ? { storeOpts } : {}),
          ...(typeof deps.trialsPerTask === "number" ? { trialsPerTask: deps.trialsPerTask } : {}),
          ...(deps.modelTag ? { model: deps.modelTag } : {}),
          ...(deps.nodePubkey ? { nodePubkey: deps.nodePubkey } : {}),
        });
      } catch (err) {
        log.warn(`attestation sweep skipped: ${String(err)}`);
      }
    }
    // §3.7: our own regression verdicts are validated fraud for the seller:
    // slash posted bonds (ledger only) and commerce-quarantine the seller.
    try {
      const fraud = new SellerBondLedger(deps.db).applyRegressionVerdicts({
        ownAttesterPubkey: pubkeyId(deps.attestKeyPair),
        commerce: new CommerceReputationLedger(deps.db),
      });
      if (fraud.verdicts > 0) {
        log.warn(
          `fraud verdicts recorded: ${fraud.verdicts} (sellers slashed/quarantined: ${fraud.sellersSlashed.join(", ")})`,
        );
        // A convicted seller must not keep contributor privileges until the
        // next consolidation: re-derive standings now.
        new ContributorStatusLedger(deps.db).recompute();
      }
    } catch (err) {
      log.warn(`fraud verdict pass skipped: ${String(err)}`);
    }
    // Exchange: push ours, pull peers' for the peer skills we hold.
    if (deps.attestationPeers?.length) {
      try {
        const shas = (
          deps.db
            .prepare(
              `SELECT text FROM chunks
                WHERE semantic_type IN ('skill', 'task_pattern')
                  AND COALESCE(lifecycle_state, 'active') = 'active'
                  AND governance_json LIKE '%"peerOrigin"%'
                ORDER BY updated_at DESC LIMIT 20`,
            )
            .all() as Array<{ text: string }>
        ).map((r) => skillContentSha256(r.text));
        const blocked = new Set(deps.blockedAttesters ?? []);
        const sync = await syncAttestations({
          db: deps.db,
          peers: deps.attestationPeers,
          contentSha256s: shas,
          ownAttesterPubkey: pubkeyId(deps.attestKeyPair),
          isBlockedAttester: (pk) => blocked.has(pk),
        });
        log.info(
          `attestation sync: pushed ${sync.pushed}, pulled ${sync.pulled}, peers failed ${sync.peersFailed}`,
        );
      } catch (err) {
        log.warn(`attestation sync skipped: ${String(err)}`);
      }
    }
  }
  const lint = await runWikiLint({
    ...storeOpts,
    ...(deps.maxPatterns ? { maxPatterns: deps.maxPatterns } : {}),
  });
  // Semantic lint (Karpathy's real lint) is slow and LLM-backed — cadence
  // gated far below the per-iteration mechanical lint.
  let semanticLint: SemanticLintResult | undefined;
  const cadenceDays = deps.semanticLintCadenceDays ?? 7;
  if (cadenceDays > 0 && deps.llmCall) {
    const now = Date.now();
    const state = await readSemanticLintState(storeOpts);
    if (now - state.lastRunAt >= cadenceDays * 24 * 60 * 60 * 1000) {
      semanticLint = await runSemanticLint({ llmCall: deps.llmCall, storeOpts, now });
    }
  }
  let publish: PublishSweepResult | undefined;
  if (deps.propagate !== false) {
    publish = await publishEligibleEvolvedSkills({
      publisher: deps.publisher ?? null,
      ...(storeOpts.configDir ? { storeOpts } : {}),
      ...(deps.maturityDays !== undefined ? { maturityDays: deps.maturityDays } : {}),
    });
  }
  return {
    ...(skillReads ? { skillReads } : {}),
    validation,
    ...(lint ? { lint } : {}),
    ...(attestation ? { attestation } : {}),
    ...(semanticLint ? { semanticLint } : {}),
    ...(publish ? { publish } : {}),
  };
}
