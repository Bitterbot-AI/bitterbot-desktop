// PLAN-25 Phase 3 (orchestrator): the `harness_evolve` dream mode. Runs during
// idle compute and closes the Self-Harness loop on the runner's own harness:
//
//   mine failures → propose K minimal policy edits → validate on held-out traces
//   (paired bootstrap, ci95Low>0) → promote one → periodically slow-update +
//   auto-rollback regressions.
//
// PLAN-64 Phase 6: how a candidate is validated is explicit.
//   - `replay` (default): both policies are EXECUTED on verifiable tasks linked
//     to held-out past executions, in the skill task gate's scratch-workspace
//     runner, and scored by the task checker (harness-evolve.replay.ts). Only
//     replayable executions count; too few of them means no promotion.
//   - `predicted`: one model call guesses pass or fail for both policies
//     (ExperimentSandbox). Nothing is executed. It is a prediction and is
//     labelled as one in insights, provenance and logs.
// Promotion and the slow-update rollback always use the same evaluator.
// Promotions are LOCAL ONLY (never gossiped over P2P) and fully reversible.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  appendHarnessPolicyProvenance,
  type HarnessPolicyEvaluationEvidence,
  promotePolicy,
  readLivePolicy,
  readPolicyHistory,
  rollbackPolicy,
  stagePolicy,
} from "../../agents/embedded-runner/harness-policy-store.js";
import {
  type HarnessPolicy,
  mergeActivePolicy,
  serializePolicyForJudge,
} from "../../agents/embedded-runner/harness-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DreamInsight } from "../dream-types.js";
import { ExperimentSandbox, type ScorePairFn } from "../experiment-sandbox.js";
import { type CorpusTask, loadTaskCorpus } from "../skill-evolution/task-corpus.js";
import type { AgentTurnFn } from "../skill-evolution/task-runner.js";
import { type HeldOutExecution, MIN_PAIRED_FOR_BOOTSTRAP } from "../skill-execution-selection.js";
import { evaluateHarnessCandidate } from "./harness-evolve.gate.js";
import { proposeHarnessCandidates } from "./harness-evolve.propose.js";
import { HarnessReplayLedger } from "./harness-evolve.replay-ledger.js";
import {
  createPredictedEvaluator,
  createReplayEvaluator,
  DEFAULT_MAX_TRIAL_TURNS_PER_CYCLE,
  type HarnessEvaluationKind,
  type HarnessEvaluationReceipt,
  type HarnessEvaluator,
  selectReplayableExecutions,
  summarizeExclusions,
} from "./harness-evolve.replay.js";
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
  /**
   * How candidates are judged. Default `replay`. An injected `scorePair`
   * executes nothing, so it defaults to (and is reported as) `predicted`.
   */
  evaluation?: HarnessEvaluationKind;
  /** Replay wiring. Without `agentTurn`, replay cannot run and refuses to promote. */
  replay?: {
    /** One real agent turn in a validation session (the skill task gate's executor). */
    agentTurn?: AgentTurnFn;
    /** False pauses dispatch (usage budget in enforce mode, shutdown, index sync). */
    canDispatch?: () => boolean;
    /** Ceiling on trial agent turns this cycle. Default 40. */
    maxTrialTurns?: number;
    maxPairsPerComparison?: number;
    /** The scratch runner's tool allow-list (validation session policy). */
    allowedTools?: ReadonlyArray<string>;
    /** Override the reviewed task corpus (tests). Defaults to skill-wiki/task-corpus.jsonl. */
    tasks?: ReadonlyArray<CorpusTask>;
    ledger?: HarnessReplayLedger;
  };
  /** Inject a judge that executes nothing (tests). Reported as a prediction. */
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

function evidenceOf(receipt: HarnessEvaluationReceipt | null): HarnessPolicyEvaluationEvidence {
  return receipt
    ? {
        evaluation: receipt.evaluation,
        nExecuted: receipt.nExecuted,
        trialIds: receipt.trialIds,
      }
    : {};
}

/** Scan depth for replay: eligibility is rare, so look well past the judged sample. */
const REPLAY_SCAN_LIMIT = 400;

/**
 * Run one harness-evolution cycle. Inert (no-op) until there is enough held-out
 * trace data and at least one mined failure cluster. In replay mode it also
 * refuses to propose or promote until enough held-out executions are
 * replayable, and says so in an insight.
 */
export async function runHarnessEvolve(args: HarnessEvolveArgs): Promise<HarnessEvolveResult> {
  const storeOpts = args.configDir ? { configDir: args.configDir } : {};
  // An injected scorer executes nothing, so it can only ever be a prediction.
  const evaluation: HarnessEvaluationKind = args.scorePair
    ? "predicted"
    : (args.evaluation ?? "replay");
  const selectionLimit = args.selectionLimit ?? 24;
  const heldOut = listGlobalHeldOutExecutions(args.db, {
    limit: evaluation === "replay" ? Math.max(selectionLimit, REPLAY_SCAN_LIMIT) : selectionLimit,
  });
  if (heldOut.length < MIN_PAIRED_FOR_BOOTSTRAP) return inert();

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

  const insights: DreamInsight[] = [];
  const note = (content: string, confidence: number, importanceScore: number) =>
    insights.push(
      makeInsight({
        cycleId: args.cycleId,
        nowMs: args.nowMs,
        content,
        confidence,
        importanceScore,
        sourceClusterIds: [],
      }),
    );

  // ── Choose the evaluator and the selection it judges ──
  // The replay evaluator is handed serialized policy texts (the ScorePairFn
  // contract); this map turns a text back into the policy it stands for.
  const knownPolicies = new Map<string, HarnessPolicy>();
  const remember = (p: HarnessPolicy): HarnessPolicy => {
    knownPolicies.set(serializePolicyForJudge(p), p);
    return p;
  };
  let selectionSet: HeldOutExecution[];
  let evaluator: HarnessEvaluator;
  if (args.scorePair) {
    selectionSet = heldOut.slice(0, selectionLimit);
    evaluator = createPredictedEvaluator(args.scorePair);
  } else if (evaluation === "predicted") {
    selectionSet = heldOut.slice(0, selectionLimit);
    evaluator = createPredictedEvaluator((a, b, sel) =>
      new ExperimentSandbox(args.db, countedLlm).scoreVersionPair(a, b, sel),
    );
  } else {
    const tasks = args.replay?.tasks ?? (await loadTaskCorpus(storeOpts))?.tasks ?? [];
    const eligibility = selectReplayableExecutions({
      executions: heldOut,
      tasks,
      allowedTools: args.replay?.allowedTools,
    });
    const replayable = eligibility.replayable.slice(0, selectionLimit);
    selectionSet = replayable.map((r) => r.execution);
    const agentTurn = args.replay?.agentTurn;
    if (!agentTurn || selectionSet.length < MIN_PAIRED_FOR_BOOTSTRAP) {
      // Fail closed: no proposer call is spent on a gate that cannot pass.
      const excluded = summarizeExclusions(eligibility.excluded);
      const why = !agentTurn
        ? "no trial executor is available in this process"
        : `${selectionSet.length} of ${heldOut.length} held-out executions are replayable ` +
          `and ${MIN_PAIRED_FOR_BOOTSTRAP} are required` +
          (excluded ? ` (excluded: ${excluded})` : "");
      log.info(`harness replay did not run: ${why}`);
      note(
        `Harness evolution (replay) evaluated nothing and promoted nothing: ${why}. ` +
          `Replay only counts executions it can re-run in a scratch workspace and verify with a task checker.`,
        0.9,
        0.2,
      );
      return {
        insights,
        llmCalls,
        recordsAnalyzed: selectionSet.length,
        promotedVersion: null,
        rolledBackTo: null,
      };
    }
    const ledger = args.replay?.ledger ?? new HarnessReplayLedger(args.db);
    const maxTrialTurns = args.replay?.maxTrialTurns ?? DEFAULT_MAX_TRIAL_TURNS_PER_CYCLE;
    ledger.openCycle(args.cycleId, maxTrialTurns);
    evaluator = createReplayEvaluator({
      cycleId: args.cycleId,
      ledger,
      maxTrialTurns,
      replayable,
      resolvePolicy: (text) => knownPolicies.get(text),
      agentTurn,
      canDispatch: args.replay?.canDispatch,
      random: args.random,
      maxPairsPerComparison: args.replay?.maxPairsPerComparison,
      storeOpts,
    });
  }
  const isReplay = evaluator.evaluation === "replay";
  const heldOutIds = selectionSet.map((e) => e.id);

  let promotedVersion: number | null = null;
  let rolledBackTo: number | null = null;
  let stoppedReason: string | null = null;

  // ── Mine → Propose → Validate → Promote (one promotion per cycle) ──
  const runProposals = async (): Promise<void> => {
    const clusters = mineFailureClusters(args.db, { nowMs: args.nowMs });
    if (clusters.length === 0) return;
    const live = remember(readLive());
    // Evidence shared by every provenance record this cycle: the mined failure
    // clusters that motivated the candidates, and the held-out traces judged.
    const triggerClusters = clusters.slice(0, 3).map((c) => ({
      signature: `${c.signature.surface}|${c.signature.terminalCause}|${c.signature.mechanism}`,
      count: c.count,
      sampleIds: c.sampleIds,
    }));
    const proposals = await proposeHarnessCandidates({
      live,
      clusters,
      llmCall: countedLlm,
      k: args.maxCandidates ?? 4,
    });
    for (const proposal of proposals) {
      remember(proposal.candidate);
      const verdict = await evaluateHarnessCandidate({
        live,
        candidate: proposal.candidate,
        selectionSet,
        scorePair: evaluator.scorePair,
        options: {
          protectedFragmentIds: args.protectedFragmentIds,
          random: args.random,
          bootstrapIterations: args.bootstrapIterations,
        },
      });
      const receipt = evaluator.takeReceipt();
      // A gate that never reached the scorer still records which evaluation applied.
      const evidence: HarnessPolicyEvaluationEvidence = {
        evaluation: evaluator.evaluation,
        ...evidenceOf(receipt),
      };
      if (!verdict.accepted) {
        const reason = receipt?.stopped ? `${verdict.reason} (${receipt.stopped})` : verdict.reason;
        log.debug(
          `candidate rejected [${evaluator.evaluation}]: ${reason} (Δ=${verdict.delta ?? "n/a"})`,
        );
        // Rejections are evidence too — record why the candidate died
        await appendHarnessPolicyProvenance(
          {
            event: "reject",
            reason,
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
            ...evidence,
          },
          storeOpts,
        );
        if (receipt?.stopped && receipt.stopped !== "unknown-policy") {
          // Budget or pause: later candidates could not be evaluated either.
          stoppedReason = receipt.stopped;
          break;
        }
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
            ...evidence,
          },
          storeOpts,
        );
        const how = isReplay
          ? `on real replay: ${receipt?.nExecuted ?? 0} paired trials executed and verified by task checkers`
          : `on a PREDICTION: one model call guessed outcomes for ${verdict.statistical?.nPaired ?? 0} past executions and nothing was executed`;
        log.info(
          `promoted harness policy v${promoted.version} [evaluation=${evaluator.evaluation}] ${how}`,
        );
        note(
          `Promoted harness policy v${promoted.version} ` +
            `(${verdict.surfacesTouched.join(",")}; ${isReplay ? "" : "predicted "}Δ=${verdict.delta?.toFixed(3)}) ` +
            `${how}. Targets: ${proposal.audit.rationale || proposal.audit.targetedMechanism}`,
          Math.min(1, Math.max(0, verdict.statistical?.ci95Low ?? 0.5)),
          Math.min(1, (verdict.delta ?? 0.1) + 0.3),
        );
      } catch (err) {
        log.warn(`promotion failed: ${String(err)}`);
      }
      break; // conservative: at most one promotion per cycle
    }
  };

  // ── Slow update + auto-quarantine (same evaluator as promotion) ──
  const every = args.slowUpdateEvery ?? 10;
  const slowUpdateDue = args.cycleIndex != null && every > 0 && args.cycleIndex % every === 0;
  const runSlowUpdate = async (): Promise<void> => {
    try {
      const history = await readPolicyHistory(args.slowUpdateDepth ?? 3, storeOpts);
      for (const ref of history) remember(ref.policy);
      const res = await runHarnessSlowUpdate({
        live: remember(readLive()),
        history,
        selectionSet,
        scorePair: async (a, b, sel) => {
          const out = await evaluator.scorePair(a, b, sel);
          // Keep the receipt of the comparison that decides (read by rollback
          // below); note a stop so the cycle can say why it ended early.
          const peek = evaluator.takeReceipt();
          lastSlowReceipt = peek;
          if (peek?.stopped) stoppedReason = peek.stopped;
          return out;
        },
        rollback: (v, reason) =>
          rollbackPolicy(v, `${reason} [evaluation=${evaluator.evaluation}]`, storeOpts, {
            evaluation: evaluator.evaluation,
            ...evidenceOf(lastSlowReceipt),
          }),
        options: { random: args.random, bootstrapIterations: args.bootstrapIterations },
      });
      rolledBackTo = res.rolledBackTo;
      if (rolledBackTo != null) {
        note(
          `Auto-rolled-back harness policy to v${rolledBackTo} (longitudinal regression ` +
            (isReplay
              ? `measured by real replay: ${lastSlowReceipt?.nExecuted ?? 0} paired trials executed).`
              : `PREDICTED by one model call; nothing was executed).`),
          0.8,
          0.8,
        );
      }
    } catch (err) {
      log.warn(`harness slow update failed: ${String(err)}`);
    }
  };
  let lastSlowReceipt: HarnessEvaluationReceipt | null = null;

  if (isReplay && slowUpdateDue) {
    // Replay has a trial budget. On a slow-update cycle the safety check gets
    // it first; a rollback is the cycle's one mutation.
    await runSlowUpdate();
    if (rolledBackTo == null && stoppedReason == null) await runProposals();
  } else {
    await runProposals();
    if (slowUpdateDue) await runSlowUpdate();
  }

  if (isReplay && stoppedReason) {
    note(
      `Harness replay stopped early (${String(stoppedReason)}). Candidates that were not fully ` +
        `replayed were not promoted.`,
      0.9,
      0.2,
    );
  }

  return {
    insights,
    llmCalls,
    recordsAnalyzed: selectionSet.length,
    promotedVersion,
    rolledBackTo,
  };
}
