// PLAN-25 Phase 3 (orchestrator): the `harness_evolve` dream mode. Runs during
// idle compute and closes the Self-Harness loop on the runner's own harness:
//
//   mine failures → propose K minimal policy edits → validate on held-out traces
//   (paired bootstrap, ci95Low>0) → promote one → periodically slow-update +
//   auto-rollback regressions.
//
// The judge is the SAME ExperimentSandbox the skill gate uses, constructed from
// the dream LLM call — so harness edits and skill edits are held to one bar.
// Promotions are LOCAL ONLY (never gossiped over P2P) and fully reversible.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { DreamInsight } from "../dream-types.js";
import {
  appendHarnessPolicyProvenance,
  promotePolicy,
  readLivePolicy,
  readPolicyHistory,
  rollbackPolicy,
  stagePolicy,
} from "../../agents/pi-embedded-runner/harness-policy-store.js";
import {
  type HarnessPolicy,
  mergeActivePolicy,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ExperimentSandbox, type ScorePairFn } from "../experiment-sandbox.js";
import { MIN_PAIRED_FOR_BOOTSTRAP } from "../skill-execution-selection.js";
import { evaluateHarnessCandidate } from "./harness-evolve.gate.js";
import { proposeHarnessCandidates } from "./harness-evolve.propose.js";
import { listGlobalHeldOutExecutions } from "./harness-evolve.selection.js";
import { runHarnessSlowUpdate } from "./harness-evolve.slow-update.js";
import { mineFailureClusters } from "./harness-evolve.weakness.js";

const log = createSubsystemLogger("memory/dream/harness-evolve");

export interface HarnessEvolveArgs {
  db: DatabaseSync;
  cycleId: string;
  /** Config-resolved baseline policy (the floor an evolved policy overlays). */
  baseline: HarnessPolicy;
  llmCall: (prompt: string) => Promise<string>;
  nowMs: number;
  /** Override the policy store root (tests). Defaults to CONFIG_DIR. */
  configDir?: string;
  /** Monotonic dream-cycle index, used to schedule the slow update. */
  cycleIndex?: number;
  maxCandidates?: number;
  selectionLimit?: number;
  slowUpdateEvery?: number;
  slowUpdateDepth?: number;
  protectedFragmentIds?: ReadonlySet<string>;
  random?: () => number;
  bootstrapIterations?: number;
  /** Inject the held-out judge (tests). Defaults to ExperimentSandbox.scoreVersionPair. */
  scorePair?: ScorePairFn;
}

export interface HarnessEvolveResult {
  insights: DreamInsight[];
  llmCalls: number;
  recordsAnalyzed: number;
  promotedVersion: number | null;
  rolledBackTo: number | null;
}

function makeInsight(args: {
  cycleId: string;
  nowMs: number;
  content: string;
  confidence: number;
  importanceScore: number;
  sourceClusterIds: string[];
}): DreamInsight {
  return {
    id: randomUUID(),
    content: args.content,
    embedding: [],
    confidence: args.confidence,
    mode: "harness_evolve",
    sourceChunkIds: [],
    sourceClusterIds: args.sourceClusterIds,
    dreamCycleId: args.cycleId,
    importanceScore: args.importanceScore,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  };
}

function inert(): HarnessEvolveResult {
  return {
    insights: [],
    llmCalls: 0,
    recordsAnalyzed: 0,
    promotedVersion: null,
    rolledBackTo: null,
  };
}

/**
 * Run one harness-evolution cycle. Inert (no-op) until there is enough held-out
 * trace data and at least one mined failure cluster, which keeps it safe to have
 * on by default on fresh installs.
 */
export async function runHarnessEvolve(args: HarnessEvolveArgs): Promise<HarnessEvolveResult> {
  const storeOpts = args.configDir ? { configDir: args.configDir } : {};
  const selectionSet = listGlobalHeldOutExecutions(args.db, { limit: args.selectionLimit ?? 24 });
  if (selectionSet.length < MIN_PAIRED_FOR_BOOTSTRAP) return inert();

  // Live = config baseline overlaid with the current evolved policy (if any).
  const readLive = () => {
    const evolved = readLivePolicy(storeOpts);
    return evolved ? mergeActivePolicy(args.baseline, evolved) : args.baseline;
  };

  let llmCalls = 0;
  const countedLlm = async (p: string): Promise<string> => {
    llmCalls += 1;
    return args.llmCall(p);
  };
  const scorePair: ScorePairFn =
    args.scorePair ??
    ((a, b, sel) => new ExperimentSandbox(args.db, countedLlm).scoreVersionPair(a, b, sel));

  const insights: DreamInsight[] = [];
  let promotedVersion: number | null = null;
  let rolledBackTo: number | null = null;

  // ── Mine → Propose → Validate → Promote (one promotion per cycle) ──
  const clusters = mineFailureClusters(args.db, { nowMs: args.nowMs });
  const live = readLive();
  // Evidence shared by every provenance record this cycle: the mined failure
  // clusters that motivated the candidates, and the held-out traces judged.
  const triggerClusters = clusters.slice(0, 3).map((c) => ({
    signature: `${c.signature.surface}|${c.signature.terminalCause}|${c.signature.mechanism}`,
    count: c.count,
    sampleIds: c.sampleIds,
  }));
  const heldOutIds = selectionSet.map((e) => e.id);
  if (clusters.length > 0) {
    const proposals = await proposeHarnessCandidates({
      live,
      clusters,
      llmCall: countedLlm,
      k: args.maxCandidates ?? 4,
    });
    for (const proposal of proposals) {
      const verdict = await evaluateHarnessCandidate({
        live,
        candidate: proposal.candidate,
        selectionSet,
        scorePair,
        options: {
          protectedFragmentIds: args.protectedFragmentIds,
          random: args.random,
          bootstrapIterations: args.bootstrapIterations,
        },
      });
      if (!verdict.accepted) {
        log.debug(`candidate rejected: ${verdict.reason} (Δ=${verdict.delta ?? "n/a"})`);
        // Rejections are evidence too — record why the candidate died
        await appendHarnessPolicyProvenance(
          {
            event: "reject",
            reason: verdict.reason,
            delta: verdict.delta,
            ci95Low: verdict.statistical?.ci95Low,
            ci95High: verdict.statistical?.ci95High,
            nPaired: verdict.statistical?.nPaired,
            surfacesTouched: verdict.surfacesTouched,
            trigger: {
              mechanism: proposal.audit.targetedMechanism,
              clusters: triggerClusters,
            },
            heldOutIds,
          },
          storeOpts,
        );
        continue;
      }
      try {
        await stagePolicy(proposal.candidate, storeOpts);
        const promoted = await promotePolicy(
          proposal.candidate,
          {
            reason: proposal.audit.targetedMechanism || "harness-evolve",
            delta: verdict.delta,
            surfacesTouched: verdict.surfacesTouched,
          },
          storeOpts,
        );
        promotedVersion = promoted.version;
        await appendHarnessPolicyProvenance(
          {
            event: "promote",
            version: promoted.version,
            reason: proposal.audit.targetedMechanism || "harness-evolve",
            delta: verdict.delta,
            ci95Low: verdict.statistical?.ci95Low,
            ci95High: verdict.statistical?.ci95High,
            nPaired: verdict.statistical?.nPaired,
            surfacesTouched: verdict.surfacesTouched,
            trigger: {
              mechanism: proposal.audit.targetedMechanism,
              clusters: triggerClusters,
            },
            heldOutIds,
          },
          storeOpts,
        );
        insights.push(
          makeInsight({
            cycleId: args.cycleId,
            nowMs: args.nowMs,
            content:
              `Promoted harness policy v${promoted.version} ` +
              `(${verdict.surfacesTouched.join(",")}; Δ=${verdict.delta?.toFixed(3)}). ` +
              `Targets: ${proposal.audit.rationale || proposal.audit.targetedMechanism}`,
            confidence: Math.min(1, Math.max(0, verdict.statistical?.ci95Low ?? 0.5)),
            importanceScore: Math.min(1, (verdict.delta ?? 0.1) + 0.3),
            sourceClusterIds: [],
          }),
        );
      } catch (err) {
        log.warn(`promotion failed: ${String(err)}`);
      }
      break; // conservative: at most one promotion per cycle
    }
  }

  // ── Slow update + auto-quarantine ──
  const every = args.slowUpdateEvery ?? 10;
  if (args.cycleIndex != null && every > 0 && args.cycleIndex % every === 0) {
    try {
      const history = await readPolicyHistory(args.slowUpdateDepth ?? 3, storeOpts);
      const res = await runHarnessSlowUpdate({
        live: readLive(),
        history,
        selectionSet,
        scorePair,
        rollback: (v, reason) => rollbackPolicy(v, reason, storeOpts),
        options: { random: args.random, bootstrapIterations: args.bootstrapIterations },
      });
      rolledBackTo = res.rolledBackTo;
      if (rolledBackTo != null) {
        insights.push(
          makeInsight({
            cycleId: args.cycleId,
            nowMs: args.nowMs,
            content: `Auto-rolled-back harness policy to v${rolledBackTo} (longitudinal regression).`,
            confidence: 0.8,
            importanceScore: 0.8,
            sourceClusterIds: [],
          }),
        );
      }
    } catch (err) {
      log.warn(`harness slow update failed: ${String(err)}`);
    }
  }

  return {
    insights,
    llmCalls,
    recordsAnalyzed: selectionSet.length,
    promotedVersion,
    rolledBackTo,
  };
}
