/**
 * PLAN-42: one evolution iteration, orchestrated.
 *
 * Phase 2 wires the Wiki Maintainer (sample traces -> consolidate into the
 * wiki); Phase 3 adds the Skill Proposer after maintenance in the same
 * iteration (the paper's component order). All dependencies are injected so
 * the pass is testable without a gateway; the dream engine's
 * `maybeRunSkillEvolutionPass` hook provides the live wiring and cadence
 * gate.
 *
 * Degradation contract (D-A: the subsystem ships ON by default):
 *   - no LLM call available (keyless install)  -> clean no-op
 *   - no event journal                         -> clean no-op
 *   - no new traces since the cursor           -> no LLM spend, cursor may
 *     still advance past excluded/held-out runs
 *   - maintainer output unparseable            -> nothing written, cursor
 *     NOT advanced (the window is retried next iteration)
 *   - anything throws                          -> caught, logged at warn,
 *     reported as reason "error"
 *
 * PLAN-44 Phase 0: EVERY attempt — no-op, parse-failed, crashed — appends
 * one record to skill-wiki/iterations.jsonl so the loop is diagnosable
 * from disk (audit: five live iterations left no machine-readable trace).
 */

import type { DatabaseSync } from "node:sqlite";
import type { KeyPair } from "../../commerce/envelope.js";
import type { EventJournal } from "../../infra/event-journal.js";
import type { PublishSweepResult, SkillPublisher } from "./p2p-publish.js";
import type { AgentTurnFn } from "./task-runner.js";
import type { SamplerStats } from "./types.js";
import type { ValidationGateOutcome } from "./validation-gate.js";
import type { WikiLintResult } from "./wiki-lint.js";
import type { SemanticLintResult } from "./wiki-semantic-lint.js";
import type { WikiStoreOptions } from "./wiki-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";
import { loadEffectiveCorpus } from "./canonical-corpus.js";
import { mineCapabilityTasks } from "./corpus-miner.js";
import { reviewedDraftIds } from "./corpus-review.js";
import { runHousekeeping } from "./housekeeping.js";
import { appendIterationRecord, buildIterationRecord } from "./iteration-log.js";

export { buildIterationRecord } from "./iteration-log.js";
import { type LlmCallFn, type MaintenanceResult, runWikiMaintenance } from "./maintainer.js";
import {
  type ApplyProposalResult,
  applyProposal,
  collectProposalEvidence,
} from "./proposal-apply.js";
import { type ProposerRunResult, runSkillProposer } from "./proposer.js";
import {
  MAX_PARSE_FAILURES,
  readSamplerState,
  sampleIteration,
  writeSamplerCursor,
  writeSamplerState,
} from "./sampler.js";

const log = createSubsystemLogger("skill-evolution/pass");

export { runHousekeeping } from "./housekeeping.js";

/**
 * The loop learns from the RECENT past forward (the paper trains on current
 * rollouts). A cursor at 0 (fresh install) or pointing into stale history
 * fast-forwards to this window instead of replaying months of old runs at
 * 40 runs/iteration — live finding from the first soak day: iteration 2
 * was consolidating May incidents while today's failures sat 35k seqs ahead.
 */
export const RECENT_WINDOW_DAYS = 14;

export interface EvolutionPassDeps {
  journal: EventJournal | null;
  llmCall: LlmCallFn | null;
  /** Separate judge call for trace labeling; defaults to llmCall. */
  judgeCall?: LlmCallFn;
  /** For dream-utility artifact registration (optional in tests). */
  db?: DatabaseSync;
  cycleId?: string;
  maxPatterns?: number;
  maxProposerTurns?: number;
  /** Set false to run maintenance only (tests / staged rollouts). */
  runProposer?: boolean;
  /** Validation gate settings (Phase 4). Gate runs whenever a proposal staged. */
  validationMode?: "records" | "tasks";
  trialsPerTask?: number;
  /** PLAN-45 2.5: ceiling on candidate/incumbent token ratio minus one (default 0.5). */
  maxTokenDelta?: number;
  /**
   * PLAN-43 Phase 3: signing key for receiver-side attestations of peer
   * skills (device identity). When set together with `agentTurn`, the
   * housekeeping sweep re-scores a bounded number of unattested peer-origin
   * skills per pass and stores signed verdicts.
   */
  attestKeyPair?: KeyPair;
  nodePubkey?: string;
  /** Peer A2A URLs to exchange attestations with (a2a.attestation.peers). */
  attestationPeers?: string[];
  blockedAttesters?: string[];
  maxActiveEvolved?: number;
  modelTag?: string;
  /** P2P propagation (Phase 5). Publisher = the orchestrator bridge or a fake. */
  propagate?: boolean;
  maturityDays?: number;
  publisher?: SkillPublisher | null;
  /** Tasks-mode real-rollout executor (validation gate builds the paired runner). */
  agentTurn?: AgentTurnFn;
  /**
   * PLAN-44 Phase 2 (adversarial C1): executor for PEER skill attestation,
   * on the `peer-` session flavor that keeps the A2A no-tools floor.
   */
  peerAgentTurn?: AgentTurnFn;
  /** Dedicated proposer model lane (stronger than the maintainer/cheap lane). */
  proposerLlmCall?: LlmCallFn;
  /** Min days between semantic (LLM) wiki lint passes. Default 7; 0 disables. */
  semanticLintCadenceDays?: number;
  /** PLAN-44 Phase 2: wall-clock budget per tasks-mode validation run. */
  validationBudgetMinutes?: number;
  /** PLAN-44 Phase 4a: reword never-triggered descriptions (default true). */
  descriptionRepair?: boolean;
  /** PLAN-44 Phase 5a: the agent workspace, to resolve relative skill-read paths. */
  workspaceDir?: string;
  /** PLAN-44 Phase 5c: rewrite non-routable harvested / received descriptions (default true). */
  routingRepair?: boolean;
  storeOpts?: WikiStoreOptions;
}

export interface EvolutionPassResult {
  ran: boolean;
  reason?: "no-journal" | "no-llm" | "no-new-traces" | "maintainer-parse-failed" | "error";
  /** PLAN-44 Phase 0: set with reason "error". */
  error?: string;
  samplerStats?: SamplerStats;
  /** B6: failure-signature cluster counts from this iteration's sampler pass. */
  failureSignatures?: Record<string, number>;
  maintenance?: MaintenanceResult;
  proposer?: ProposerRunResult;
  proposalOutcome?: ApplyProposalResult;
  validation?: ValidationGateOutcome[];
  lint?: WikiLintResult;
  semanticLint?: SemanticLintResult;
  publish?: PublishSweepResult;
  attestation?: { attested: number; skipped: number; held: number };
  cursorBefore?: number;
  cursorAfter?: number;
}

/**
 * Run one evolution iteration. Never throws — evolution must not break
 * dreams. Always appends an iteration record (best-effort).
 */
export async function runEvolutionIteration(deps: EvolutionPassDeps): Promise<EvolutionPassResult> {
  const startedAt = Date.now();
  let result: EvolutionPassResult;
  try {
    result = await runEvolutionIterationInner(deps);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`evolution iteration failed: ${message}`);
    // Telemetry keeps the message and the first frame only (adversarial
    // M5: records reach WS clients through the status RPC).
    result = {
      ran: false,
      reason: "error",
      error: message.split("\n").slice(0, 2).join(" | ").slice(0, 400),
    };
  }
  try {
    await appendIterationRecord(
      buildIterationRecord(result, { startedAt, cycleId: deps.cycleId ?? null }),
      deps.storeOpts ?? {},
    );
  } catch (err) {
    log.debug(`iteration record not written: ${String(err)}`);
  }
  return result;
}

async function runEvolutionIterationInner(deps: EvolutionPassDeps): Promise<EvolutionPassResult> {
  if (!deps.journal) {
    return { ran: false, reason: "no-journal" };
  }
  if (!deps.llmCall) {
    return { ran: false, reason: "no-llm" };
  }
  const storeOpts = deps.storeOpts ?? {};
  const state = await readSamplerState(storeOpts);
  let cursorBefore = state.cursorSeq;
  try {
    const windowFloor = deps.journal.firstSeqSince(
      Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    if (windowFloor > 0 && cursorBefore < windowFloor - 1) {
      log.info(
        `fast-forwarding sampler cursor past stale history: ${cursorBefore} -> ${windowFloor - 1} (recent window ${RECENT_WINDOW_DAYS}d)`,
      );
      cursorBefore = windowFloor - 1;
      await writeSamplerCursor(cursorBefore, storeOpts);
    }
  } catch {
    // Older journal without the ts index path — proceed from the stored cursor.
  }
  const sample = await sampleIteration(deps.journal, {
    cursorSeq: cursorBefore,
    judgeCall: deps.judgeCall ?? deps.llmCall,
    pending: state.pending,
    processedRunIds: state.processed,
    ...(storeOpts.configDir ? { storeOpts } : {}),
  });

  if (sample.samples.length === 0) {
    // Nothing to learn this window. Advance past the examined (excluded /
    // held-out / unknown) runs so they are not rescanned forever. Held
    // proposals, lint, and matured publishes still get their sweep —
    // eligibility ripens with time, not with new traces.
    if (
      sample.nextCursorSeq > cursorBefore ||
      sample.pending.length !== state.pending.length ||
      sample.processedRunIds.length !== state.processed.length
    ) {
      await writeSamplerState(
        {
          cursorSeq: Math.max(cursorBefore, sample.nextCursorSeq),
          pending: sample.pending,
          processed: sample.processedRunIds,
          parseFailures: state.parseFailures,
        },
        storeOpts,
      );
    }
    const housekeeping = deps.runProposer !== false ? await runHousekeeping(deps, storeOpts) : {};
    return {
      ran: false,
      reason: "no-new-traces",
      samplerStats: sample.stats,
      failureSignatures: sample.failureSignatures,
      ...housekeeping,
      cursorBefore,
      cursorAfter: Math.max(cursorBefore, sample.nextCursorSeq),
    };
  }

  const maintenance = await runWikiMaintenance({
    samples: sample.samples,
    llmCall: deps.llmCall,
    storeOpts: { ...storeOpts, ...(deps.maxPatterns ? { maxPatterns: deps.maxPatterns } : {}) },
  });

  if (!maintenance.applied) {
    // Unparseable output: write nothing to the wiki. The window is retried
    // next cadence window up to MAX_PARSE_FAILURES times (adversarial C1:
    // one prose-inducing trace must not pin the loop forever), after which
    // the cursor advances past it. Housekeeping still runs either way —
    // held proposals, lint, and matured publishes must not starve.
    const prior =
      state.parseFailures && state.parseFailures.cursorSeq === cursorBefore
        ? state.parseFailures.count
        : 0;
    const count = prior + 1;
    const skipWindow = count >= MAX_PARSE_FAILURES;
    log.warn(
      `wiki maintainer output unparseable (${count}/${MAX_PARSE_FAILURES} at cursor ${cursorBefore}); ` +
        (skipWindow ? "skipping this window" : "iteration will retry next cadence window") +
        (maintenance.parseIssues?.length
          ? ` (issues: ${maintenance.parseIssues.join("; ").slice(0, 300)})`
          : "") +
        (maintenance.rawSample
          ? ` (raw: ${maintenance.rawSample.replace(/\s+/g, " ").slice(0, 300)})`
          : ""),
    );
    await writeSamplerState(
      skipWindow
        ? {
            cursorSeq: sample.nextCursorSeq,
            pending: sample.pending,
            processed: sample.processedRunIds,
            parseFailures: null,
          }
        : {
            cursorSeq: cursorBefore,
            pending: state.pending,
            processed: state.processed,
            parseFailures: { cursorSeq: cursorBefore, count },
          },
      storeOpts,
    );
    const housekeeping = deps.runProposer !== false ? await runHousekeeping(deps, storeOpts) : {};
    return {
      ran: true,
      reason: "maintainer-parse-failed",
      samplerStats: sample.stats,
      failureSignatures: sample.failureSignatures,
      maintenance,
      ...housekeeping,
      cursorBefore,
      cursorAfter: skipWindow ? sample.nextCursorSeq : cursorBefore,
    };
  }

  await writeSamplerState(
    {
      cursorSeq: sample.nextCursorSeq,
      pending: sample.pending,
      processed: sample.processedRunIds,
      parseFailures: null,
    },
    storeOpts,
  );

  if (deps.db && maintenance.apply) {
    for (const name of [...maintenance.apply.created, ...maintenance.apply.updated]) {
      recordDreamArtifact(deps.db, {
        lane: "evolution",
        artifactKind: "wiki_pattern",
        artifactId: `wiki-pattern:${name}`,
        cycleId: deps.cycleId ?? null,
      });
    }
  }

  // Phase 3: the Skill Proposer runs AFTER maintenance in the same
  // iteration (paper component order), reading the just-updated wiki. Its
  // proposal is staged through the SICA gate but never promoted here.
  let proposer: ProposerRunResult | undefined;
  let proposalOutcome: ApplyProposalResult | undefined;
  if (deps.runProposer !== false) {
    const proposerDeps = {
      samples: sample.samples,
      ...(deps.storeOpts ? { storeOpts: deps.storeOpts } : {}),
      ...(deps.maxProposerTurns ? { maxTurns: deps.maxProposerTurns } : {}),
      ...(deps.db ? { db: deps.db } : {}),
      journal: deps.journal,
    };
    try {
      proposer = await runSkillProposer({
        llmCall: deps.proposerLlmCall ?? deps.llmCall,
        ...proposerDeps,
      });
      proposer.lane = deps.proposerLlmCall ? "dedicated" : "evolution";
    } catch (err) {
      if (!deps.proposerLlmCall) {
        throw err;
      }
      // Adversarial H4: the dedicated proposer lane (D-1: the agent's
      // primary model) may be a CLI provider or lack a background-usable
      // key. Fall back to the evolution lane rather than losing the
      // iteration after the wiki was already written.
      log.warn(
        `proposer lane failed (${String(err).slice(0, 200)}); retrying on the evolution lane`,
      );
      proposer = await runSkillProposer({ llmCall: deps.llmCall, ...proposerDeps });
      proposer.lane = "fallback";
    }
    proposalOutcome = await applyProposal(proposer.proposal, {
      ...(deps.storeOpts ? { storeOpts: deps.storeOpts } : {}),
      iteration: deps.cycleId ?? new Date().toISOString().slice(0, 10),
      // PLAN-44 Phase 3: bind the proposal to the traces it actually read.
      evidence: collectProposalEvidence(proposer.reads, sample.samples),
    });
  }

  // Corpus miner (2026-09-02 upgrade): draft capability-suite tasks from
  // this window's FAILING traces into the pending-review file. Best-effort
  // and draft-only — nothing enters the live corpus without human review.
  try {
    // PLAN-44 Phase 1: human-authored tasks that hit an environment failure
    // are not maintainer material but still describe a real capability.
    const iteration = deps.cycleId ?? new Date().toISOString().slice(0, 10);
    const failingTraces = [
      ...sample.samples
        .filter((s) => s.label.label === "fail")
        .map((s) => ({ text: s.formattedLog, runId: s.trace.runId, iteration })),
      ...sample.envFailTexts.map((text) => ({ text, iteration })),
    ];
    if (failingTraces.length > 0) {
      const effective = await loadEffectiveCorpus(storeOpts);
      // Reviewed ids (accepted OR rejected) are never redrafted (Phase 2).
      const reviewed = await reviewedDraftIds(storeOpts);
      await mineCapabilityTasks({
        failingTraces,
        llmCall: deps.llmCall,
        existingIds: new Set([...(effective?.tasks ?? []).map((t) => t.id), ...reviewed]),
        ...(deps.storeOpts ? { storeOpts: deps.storeOpts } : {}),
      });
    }
  } catch (err) {
    log.debug(`corpus miner skipped: ${String(err)}`);
  }

  // Phase 4+5: settle EVERY staged evolution proposal (this iteration's
  // and any held from earlier iterations) through the validation gate,
  // then lint the wiki and publish matured validated skills.
  const housekeeping = deps.runProposer !== false ? await runHousekeeping(deps, storeOpts) : {};

  log.info(
    `evolution iteration: ${sample.samples.length} traces (${sample.stats.failsSelected}f/${sample.stats.passesSelected}p, ${sample.stats.runsWithTask} with task, ${sample.stats.envFails} env-fail skipped, ${sample.stats.pairs} pairs) -> ` +
      `${maintenance.apply?.created.length ?? 0} patterns created, ${maintenance.apply?.updated.length ?? 0} updated, ` +
      `${maintenance.apply?.dropped.length ?? 0} dropped` +
      (proposer
        ? `; proposal: ${proposer.proposal.action} (${proposalOutcome?.outcome ?? "?"}, ${proposer.turns} turns, ${proposer.protocolErrors} protocol errors)`
        : ""),
  );
  return {
    ran: true,
    samplerStats: sample.stats,
    failureSignatures: sample.failureSignatures,
    maintenance,
    ...(proposer ? { proposer } : {}),
    ...(proposalOutcome ? { proposalOutcome } : {}),
    ...housekeeping,
    cursorBefore,
    cursorAfter: sample.nextCursorSeq,
  };
}
