/**
 * PLAN-42 Phase 4: the validation gate — the only path from "staged
 * evolution proposal" to "live skill". Fidelity F3/F5/F7:
 *
 *   - Strict acceptance: the candidate must MEASURABLY beat the incumbent
 *     ("records" mode: paired LLM scoring over held-out traces; "tasks"
 *     mode: real rollouts over the seeded corpus) — exact one-sided sign
 *     test on discordant paired deltas, p < 0.05. Measured non-improvement
 *     REJECTS; underpowered evidence HOLDS.
 *   - Rejection discards the staged candidate (the skill set reverts to
 *     the incumbent by construction) — the wiki is untouched, and the
 *     verdict + scores land in skill-impact.md programmatically.
 *   - Promotion carries PURPOSE.md + .evolution-meta.json (enriched with
 *     the validation verdict, mode, corpus version, and model tag) to the
 *     live dir, and enforces the maxActiveEvolved cap.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type { LlmCallFn } from "./maintainer.js";
import { DEFAULT_CANARY_FRACTION, registerCanary } from "../../agents/skills/canary-registry.js";
import { listLiveSkillIndex } from "../../agents/skills/description-overlap.js";
import {
  appendImpactEntry,
  type ImpactTrailOptions,
  readProvenance,
} from "../../agents/skills/impact-trail.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { promoteStaged } from "../../agents/skills/skill-promote.js";
import {
  discardStaged,
  liveSkillDir,
  readLive,
  readStaged,
  resolveStorageRoots,
  stagingSkillDir,
  type StorageRoots,
  stagingSkillPath,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deriveCanonicalSeed, loadEffectiveCorpus } from "./canonical-corpus.js";
import { MAX_DESCRIPTION_REPAIRS, repairDescription } from "./description-repair.js";
import { atomicWriteFile, atomicWriteJson } from "./fs-atomic.js";
import {
  HOLD_BACKOFF_MS,
  HOLD_BACKOFF_VERDICTS,
  memoizeTrials,
  sweepStaleTrials,
  CONTENT_CHANGE_VERDICTS,
} from "./gate-support.js";
import { hashProposalContent } from "./proposal-apply.js";
import { type AgentTurnFn, makeRuntimePathwayRunner } from "./task-runner.js";
import { TrialCache } from "./trial-cache.js";
import { validateAgainstRecords } from "./validate-records.js";
import {
  type TaskRunnerFn,
  validateAgainstTasks,
  SIGN_TEST_ALPHA,
  isCanonicalTask,
  relevantCapabilityTasks,
} from "./validate-tasks.js";
import { countCapabilityTasks, resolveEffectiveValidationMode } from "./validation-mode.js";

const log = createSubsystemLogger("skill-evolution/validation-gate");

/** PLAN-45 2.4: measured attempts a lineage gets before it is closed. alpha_k = 0.05 / 2^k. */
export const MAX_GATE_ATTEMPTS = 3;
/**
 * Verdicts that DECIDED something and spend a lineage attempt. Holds that
 * carry no decision (insufficient evidence, cost, never-triggered, budget)
 * spend nothing (adversarial H1/M1).
 */
const DECISIVE_VERDICTS = new Set(["accepted", "no-improvement", "regression", "over-triggered"]);
/** Alpha schedule per attempt; never below what the informative suite can reach. */
const ALPHA_SCHEDULE = [0.05, 0.025, 0.0125];
export function alphaForAttempt(attempt: number, capabilityTasks: number): number {
  const wanted = ALPHA_SCHEDULE[Math.min(attempt, ALPHA_SCHEDULE.length - 1)] ?? SIGN_TEST_ALPHA;
  // 0.5^n is the smallest p an n-task suite can produce; a stricter alpha
  // would make the attempt unwinnable by construction.
  const reachable = 0.5 ** capabilityTasks;
  if (wanted > reachable) {
    return wanted;
  }
  // The tightest schedule value the suite can still reach.
  let best = SIGN_TEST_ALPHA;
  for (const a of ALPHA_SCHEDULE) {
    if (a > reachable) {
      best = a;
    }
  }
  return best;
}

export const DEFAULT_MAX_ACTIVE_EVOLVED = 5;

/** The `description:` frontmatter value of a SKILL.md, or null. */
export function skillDescription(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    return null;
  }
  const line = fm[1]?.split("\n").find((l) => /^description\s*:/.test(l));
  if (!line) {
    return null;
  }
  const value = line.replace(/^description\s*:\s*/, "").trim();
  return value.replace(/^["']|["']$/g, "") || null;
}
/** PLAN-44 Phase 2: wall-clock budget for one tasks-mode validation run. */
export const DEFAULT_VALIDATION_BUDGET_MINUTES = 45;

/** PLAN-45 Phase 3.1: the lifecycle ladder of an evolved skill. */
export type EvolutionLadderState =
  | "staged"
  | "validated"
  | "canary"
  | "stable"
  | "rolled-back"
  | "retired";

export interface EvolutionLadder {
  state: EvolutionLadderState;
  at: number;
  by: "pipeline" | "gate" | "monitor" | "model-drift" | "operator";
  reason?: string;
  previous?: EvolutionLadderState;
}

export interface EvolutionMeta {
  origin: string;
  stagedAt?: number;
  iteration?: string | null;
  /** PLAN-45 Phase 3.1: staged -> canary (gate) -> stable (monitor) | rolled-back | retired. */
  ladder?: EvolutionLadder;
  /**
   * PLAN-45 Phase 3.3: archive version of the live SKILL.md this promotion
   * replaced (null for a create). A regression rolls back to it.
   */
  promotedFrom?: number | null;
  /** PLAN-45 Phase 3.2: the current or last canary window. */
  canary?: {
    startedAt: number;
    bucketFraction: number;
    reason: string;
    endedAt?: number;
    /** Monitor looks already taken (exposed-cohort sizes), so a look is never repeated. */
    checkpoints?: number[];
  };
  /** PLAN-45 Phase 3.5: the primary model changed after validation; re-canaried. */
  modelDrift?: { from: string; to: string; at: number };
  /** PLAN-42 Phase 5: P2P publish-once marker; `contentHash` is the wire hash (body + trailer). */
  published?: { at: number; contentHash?: string };
  /** PLAN-45 Phase 3.4: a published version was retracted on the mesh. */
  retracted?: { at: number; contentHash: string; reason: string };
  /** PLAN-44 Phase 3: traces the proposer read and their trust classes. */
  evidence?: { runIds: string[]; origins: string[] };
  /** PLAN-44 Phase 3: hash of the SKILL.md the pipeline staged (tamper check). */
  contentHash?: string;
  /** PLAN-44 Phase 4a: description repairs applied so far (capped). */
  descriptionRepairs?: number;
  descriptionRepairLog?: Array<{ at: number; from: string; to: string; reason: string }>;
  /** PLAN-45 2.4: measured gate attempts for this lineage (alpha is spent across them). */
  gateAttempts?: number;
  /**
   * PLAN-45 2.8: the paired LLM judge over held-out traces, kept as a
   * DIAGNOSTIC only. It never promotes and never rejects.
   */
  recordsJudge?: {
    verdict: string;
    meanDelta?: number;
    ci95Low?: number;
    ci95High?: number;
    trials: number;
    at: number;
  };
  /** PLAN-44 Phase 2: last hold verdict on the staged proposal (24h backoff). */
  lastValidation?: {
    at: number;
    verdict: string;
    contentHash: string;
    corpusPrefix: string;
    modelTag: string;
  };
  validation?: {
    mode: "records" | "tasks";
    verdict: string;
    meanDelta?: number;
    ci95Low?: number;
    ci95High?: number;
    /** Exact sign-test p-value — the gate statistic (2026-09-02 upgrade). */
    pValue?: number;
    wins?: number;
    losses?: number;
    trials?: number;
    trialsPerTask?: number;
    corpusVersion?: string;
    /** Canonical-corpus seed the run was scored on (anti-memorization). */
    corpusSeed?: number;
    /** PLAN-44 Phase 2: candidate SKILL.md read rates via the runtime pathway. */
    candidateReadRate?: { capability: number | null; regression: number | null };
    /** PLAN-44 Phase 2: tokens per arm when the executor reports usage. */
    tokens?: { incumbent: number; candidate: number };
    /** PLAN-44 Phase 2: incumbent trials served from the memo. */
    cachedIncumbentTrials?: number;
    /** PLAN-45 Phase 2.1: canonical capability tasks dropped by per-model calibration. */
    calibrationDropped?: Array<{ id: string; rate: number }>;
    /** PLAN-45 2.4: alpha this attempt was judged at and the SPRT state. */
    alpha?: number;
    /** PLAN-45 2.2: capability tasks withheld because they share provenance with the proposal. */
    excludedTasks?: string[];
    sequential?: {
      wins: number;
      losses: number;
      llr: number;
      decision: string;
      stoppedEarly: boolean;
      tasksRun: number;
      tasksPlanned: number;
    };
    /** PLAN-45 2.5: candidate/incumbent token ratio minus one over capability tasks. */
    tokenDelta?: number;
    maxTokenDelta?: number;
    wallMs?: { incumbent: number; candidate: number };
    perTask?: Array<{
      id: string;
      suite: string;
      incumbent: number;
      candidate: number;
      credited: number;
      trials: number;
    }>;
    validatedAt: number;
    model?: string;
  };
}

export interface ValidationGateDeps {
  journal: EventJournal | null;
  llmCall: LlmCallFn | null;
  storeOpts?: ImpactTrailOptions;
  mode?: "records" | "tasks";
  /**
   * Tasks-mode executor: runs one real agent turn. The gate builds the
   * paired candidate/incumbent runner per-skill from this (full-injection).
   * Tests may instead inject a pre-built `runTask` directly.
   */
  agentTurn?: AgentTurnFn;
  /** Pre-built paired runner — test override; bypasses agentTurn. */
  runTask?: TaskRunnerFn;
  /** Trials per task per arm in tasks mode (config skills.evolution.trialsPerTask). */
  trialsPerTask?: number;
  /** PLAN-45 2.5: ceiling on candidate/incumbent token ratio minus one (config skills.evolution.maxTokenDelta). */
  maxTokenDelta?: number;
  maxActiveEvolved?: number;
  /** Model tag recorded into the promoted skill's provenance. */
  modelTag?: string;
  iteration?: string;
  /** PLAN-44 Phase 2: wall-clock budget per tasks-mode validation (config). */
  validationBudgetMinutes?: number;
  /** PLAN-44 Phase 4a: reword a never-triggered description (default true). */
  descriptionRepair?: boolean;
  /** Test override for the incumbent memo (defaults to the on-disk sqlite). */
  trialCache?: TrialCache;
}

export interface ValidationGateOutcome {
  skillName: string;
  outcome: "promoted" | "rejected" | "held" | "error";
  detail: string;
}

async function readEvolutionMeta(dir: string): Promise<EvolutionMeta | null> {
  try {
    const raw = await fs.readFile(path.join(dir, ".evolution-meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as EvolutionMeta;
    return parsed.origin === "wiki-evolution" ? parsed : null;
  } catch {
    return null;
  }
}

/** Names of staged proposals that came from evolution (have the meta marker). */
export async function listStagedEvolutionProposals(roots: StorageRoots): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(roots.stagingRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      continue;
    }
    if (await readEvolutionMeta(path.join(roots.stagingRoot, name))) {
      out.push(name);
    }
  }
  return out.toSorted();
}

/** Count live skills carrying wiki-evolution provenance (for the cap). */
export async function countActiveEvolvedSkills(roots: StorageRoots): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(roots.liveRoot);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of entries) {
    const meta = await readEvolutionMeta(path.join(roots.liveRoot, name));
    // Adversarial 3-7: a demoted version left in place (pre-manifest
    // rollback) is not in service and must not hold a slot.
    if (meta && meta.ladder?.state !== "rolled-back" && meta.ladder?.state !== "retired") {
      count += 1;
    }
  }
  return count;
}

/**
 * Validate and settle every staged evolution proposal. Never throws; every
 * proposal ends in exactly one of promoted / rejected / held / error, each
 * recorded in the impact trail.
 */
export async function runValidationGate(
  deps: ValidationGateDeps,
): Promise<ValidationGateOutcome[]> {
  const storeOpts = deps.storeOpts ?? {};
  const trailOpts = storeOpts.configDir ? { configDir: storeOpts.configDir } : {};
  const roots = resolveStorageRoots(storeOpts.configDir ? { configDir: storeOpts.configDir } : {});
  const outcomes: ValidationGateOutcome[] = [];
  const staged = await listStagedEvolutionProposals(roots);
  if (staged.length > 0) {
    await sweepStaleTrials(trailOpts);
  }
  // One memo handle per gate run, closed when the run ends (adversarial L2).
  let cache: TrialCache | null = deps.trialCache ?? null;
  if (!cache && staged.length > 0) {
    try {
      cache = TrialCache.open(trailOpts);
    } catch (err) {
      log.debug(`trial cache unavailable: ${String(err)}`);
    }
  }
  try {
    for (const name of staged) {
      try {
        outcomes.push(
          await settleOne(name, roots, { ...deps, trialCache: cache ?? undefined }, trailOpts),
        );
      } catch (err) {
        log.warn(`validation gate error for ${name}: ${String(err)}`);
        outcomes.push({ skillName: name, outcome: "error", detail: String(err) });
      }
    }
  } finally {
    if (!deps.trialCache) {
      cache?.close();
    }
  }
  return outcomes;
}

async function settleOne(
  name: string,
  roots: StorageRoots,
  deps: ValidationGateDeps,
  trailOpts: ImpactTrailOptions,
): Promise<ValidationGateOutcome> {
  const stagedDir = stagingSkillDir(roots, name);
  const staged = await readStaged(roots, name);
  const meta = await readEvolutionMeta(stagedDir);
  if (!staged || !meta) {
    return { skillName: name, outcome: "error", detail: "staged content or meta vanished" };
  }
  if (staged.meta.gateStatus !== "passed") {
    // The SICA gate already refused it; sweep it out of staging.
    await discardStaged(roots, name);
    return { skillName: name, outcome: "rejected", detail: "staging gate not passed" };
  }
  const incumbent = await readLive(roots, name);
  const isCreate = incumbent === null;
  const contentHash = hashProposalContent(staged.content);

  // Adversarial H1: the staged SKILL.md must be the one the pipeline wrote.
  // stageSkill strips the sidecars for other authors, but a direct file
  // write would not go through it; the meta's hash is the last word.
  if (
    staged.meta.author !== "evolution" ||
    (meta.contentHash !== undefined && meta.contentHash !== contentHash)
  ) {
    await discardStaged(roots, name);
    await appendImpactEntry(
      {
        source: "evolution",
        action: "validate",
        skillName: name,
        verdict: "rejected",
        detail: `staged content does not match the pipeline's record (author=${staged.meta.author}); discarded`,
        contentHash,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { skillName: name, outcome: "rejected", detail: "staged content tampered" };
  }

  // PLAN-44 Phase 3 (TMA-NM): content-based defences are launderable, so
  // the evidence's ORIGIN is bound at write time and checked here. A
  // proposal whose cited traces are all third-party text (circle, A2A,
  // subagent, guest, unknown) never reaches validation. Checked before any
  // LLM or agent spend.
  if (meta.evidence && !meta.evidence.origins.some((o) => o === "human" || o === "system")) {
    await appendImpactEntry(
      {
        source: "evolution",
        action: "validate",
        skillName: name,
        verdict: "rejected",
        detail: `untrusted-evidence-only (origins: ${meta.evidence.origins.join(", ")}); held in staging`,
        contentHash,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { skillName: name, outcome: "held", detail: "untrusted-evidence-only" };
  }

  // The cap only constrains NET-NEW evolved skills; patches to existing
  // skills do not add to the count.
  if (isCreate) {
    const cap = deps.maxActiveEvolved ?? DEFAULT_MAX_ACTIVE_EVOLVED;
    const active = await countActiveEvolvedSkills(roots);
    if (active >= cap) {
      // HOLD rather than reject: the proposal may be good; the node is at
      // its evolved-skill budget until the lint/retirement pass frees room.
      await appendImpactEntry(
        {
          source: "evolution",
          action: "validate",
          skillName: name,
          verdict: "rejected",
          detail: `maxActiveEvolved cap reached (${active}/${cap}); held in staging`,
          contentHash,
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
        },
        trailOpts,
      );
      return { skillName: name, outcome: "held", detail: `cap ${active}/${cap}` };
    }
  }

  // Canonical baseline + grown corpus (PLAN-42 §5.7 / PLAN-43 §3.6): a
  // fresh node with no trace history still validates against the shipped
  // canonical tasks instead of falling back to records. The seed rotates
  // DAILY per model (PLAN-44 Phase 2): memorizing the public exemplar
  // instances still buys nothing (the proposer never sees the corpus), and
  // every proposal settled the same day shares canonical instances so the
  // incumbent memo can serve them.
  const corpusSeed = deriveCanonicalSeed(
    "gate",
    deps.modelTag ?? "unknown",
    new Date().toISOString().slice(0, 10),
  );
  const loadedCorpus = await loadEffectiveCorpus(trailOpts, corpusSeed);
  // PLAN-45 2.2 (I3): a capability task mined from a run this proposal
  // read, or mined in the iteration that proposed it, never gates it
  // (train/test split; the miner and the proposer share a window).
  const evidenceRuns = new Set(meta.evidence?.runIds ?? []);
  const excludedTasks = (loadedCorpus?.tasks ?? [])
    .filter(
      (t) =>
        t.suite !== "regression" &&
        ((t.sourceRunId !== undefined && evidenceRuns.has(t.sourceRunId)) ||
          (t.sourceIteration !== undefined &&
            meta.iteration !== undefined &&
            meta.iteration !== null &&
            t.sourceIteration === meta.iteration)),
    )
    .map((t) => t.id);
  const excludedSet = new Set(excludedTasks);
  const corpus =
    loadedCorpus && excludedTasks.length > 0
      ? {
          tasks: loadedCorpus.tasks.filter((t) => !excludedSet.has(t.id)),
          version: `${loadedCorpus.version}-x${excludedTasks.length}`,
        }
      : loadedCorpus;
  // PLAN-44 D-2: explicit config wins; otherwise tasks mode once the corpus
  // carries enough reviewed capability tasks for the sign test.
  const { mode, source: modeSource } = resolveEffectiveValidationMode(
    deps.mode,
    countCapabilityTasks(corpus),
  );
  let verdictAccepted = false;
  let verdictDetail = "";
  let validationRecord: EvolutionMeta["validation"];

  // Build the paired runner: a test may inject runTask directly; otherwise
  // it is composed per-skill from agentTurn via the RUNTIME PATHWAY
  // (PLAN-44 D-3: index entry + read tool in a scratch workspace).
  const incumbentHash = incumbent === null ? "none" : hashProposalContent(incumbent);
  const baseRunner: TaskRunnerFn | undefined =
    deps.runTask ??
    (deps.agentTurn
      ? makeRuntimePathwayRunner({
          agentTurn: deps.agentTurn,
          journal: deps.journal,
          candidate: { name, content: staged.content },
          incumbent: incumbent === null ? null : { name, content: incumbent },
          proposalId: `${name}-${contentHash}`,
          ...(trailOpts.configDir ? { storeOpts: trailOpts } : {}),
        })
      : undefined);
  let cachedIncumbentTrials = 0;
  let cachedCandidateTrials = 0;
  const runTask: TaskRunnerFn | undefined = baseRunner
    ? memoizeTrials(baseRunner, {
        cache: deps.trialCache ?? null,
        candidateHash: contentHash,
        incumbentHash,
        modelTag: deps.modelTag ?? "unknown",
        onHit: (variant) => {
          if (variant === "incumbent") {
            cachedIncumbentTrials += 1;
          } else {
            cachedCandidateTrials += 1;
          }
        },
      })
    : undefined;
  // Adversarial H2: a held proposal whose content and corpus have not
  // changed is not re-validated more than once a day.
  const corpusPrefix = corpus?.version.replace(/-s\d+/, "") ?? "";
  const last = meta.lastValidation;
  if (
    last &&
    last.contentHash === contentHash &&
    last.modelTag === (deps.modelTag ?? "unknown") &&
    CONTENT_CHANGE_VERDICTS.has(last.verdict)
  ) {
    return {
      skillName: name,
      outcome: "held",
      detail: `held (${last.verdict}); the same content costs the same; edit the body to re-measure`,
    };
  }
  if (
    last &&
    last.contentHash === contentHash &&
    last.corpusPrefix === corpusPrefix &&
    last.modelTag === (deps.modelTag ?? "unknown") &&
    HOLD_BACKOFF_VERDICTS.has(last.verdict) &&
    Date.now() - last.at < HOLD_BACKOFF_MS
  ) {
    return {
      skillName: name,
      outcome: "held",
      detail: `held (${last.verdict}); retry after ${new Date(last.at + HOLD_BACKOFF_MS).toISOString()} unless content or corpus changes`,
    };
  }
  // PLAN-45 2.4: alpha spending across a lineage's DECISIVE attempts. The
  // lineage is the skill name and its record is the provenance trail, so a
  // re-proposal under the same name continues the count (adversarial H1)
  // and the proposer's "Previously tried" block agrees with the gate.
  const trailForAttempts = await readProvenance(trailOpts);
  const attemptsSoFar = Math.max(
    meta.gateAttempts ?? 0,
    trailForAttempts.filter(
      (e) =>
        e.source === "evolution" &&
        e.action === "validate" &&
        e.skillName === name &&
        typeof e.stats === "object" &&
        e.stats !== null &&
        (e.verdict === "accepted" || e.verdict === "rejected"),
    ).length,
  );
  if (attemptsSoFar >= MAX_GATE_ATTEMPTS) {
    await discardStaged(roots, name);
    const detail = `lineage-exhausted: ${attemptsSoFar} measured gate attempts without acceptance`;
    await appendImpactEntry(
      {
        source: "evolution",
        action: "validate",
        skillName: name,
        verdict: "rejected",
        detail,
        contentHash,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
        ...(deps.modelTag ? { model: deps.modelTag } : {}),
      },
      trailOpts,
    );
    return { skillName: name, outcome: "rejected", detail };
  }
  const informativeCapability = corpus
    ? corpus.tasks.filter((t) => t.suite !== "regression").length
    : 0;
  const alpha = alphaForAttempt(attemptsSoFar, informativeCapability);
  // PLAN-45 2.8 (D-7): `validationMode: "records"` now means "also run the
  // paired judge over held-out traces as a DIAGNOSTIC"; its opinion lands
  // on the meta for the evidence record and never decides anything.
  if (deps.mode === "records" && deps.journal && deps.llmCall && !meta.recordsJudge) {
    try {
      const judged = await validateAgainstRecords({
        journal: deps.journal,
        llmCall: deps.llmCall,
        candidateName: name,
        candidateContent: staged.content,
        incumbentContent: incumbent,
      });
      meta.recordsJudge = {
        verdict: judged.reason,
        ...(judged.meanDelta !== undefined ? { meanDelta: judged.meanDelta } : {}),
        ...(judged.ci95Low !== undefined ? { ci95Low: judged.ci95Low } : {}),
        ...(judged.ci95High !== undefined ? { ci95High: judged.ci95High } : {}),
        trials: judged.trials,
        at: Date.now(),
      };
      await atomicWriteJson(path.join(stagedDir, ".evolution-meta.json"), meta);
    } catch (err) {
      log.debug(`records diagnostic failed for ${name}: ${String(err)}`);
    }
  }
  // Adversarial M2: the production runner cannot observe skill reads
  // without the journal; every candidate pass would be credited. Hold.
  if (mode === "tasks" && deps.agentTurn && !deps.runTask && !deps.journal) {
    return {
      skillName: name,
      outcome: "held",
      detail: "runner-unobservable: no event journal to observe skill reads (retry next pass)",
    };
  }
  if (mode === "tasks" && (!runTask || !corpus)) {
    // PLAN-45 2.8: no executor or no corpus is a HOLD, never a fallback to
    // the judge (adversarial leak: explicit tasks mode used to promote on
    // records when the executor was missing).
    return {
      skillName: name,
      outcome: "held",
      detail: !runTask
        ? "no-executor: tasks mode without an executor (retry next pass)"
        : "no-corpus: tasks mode without a corpus (retry next pass)",
    };
  }
  if (mode === "tasks" && runTask) {
    if (!corpus) {
      verdictDetail = "unreachable";
    } else {
      const budgetMinutes = deps.validationBudgetMinutes ?? DEFAULT_VALIDATION_BUDGET_MINUTES;
      // PLAN-45 Phase 2.1: per-model calibration from the incumbent stats
      // accumulated across earlier gate runs (trial-cache task_stats).
      const modelTagForStats = deps.modelTag ?? "unknown";
      const calibration = deps.trialCache
        ? { incumbentStats: deps.trialCache.incumbentTaskStats(modelTagForStats) }
        : undefined;
      const verdict = await validateAgainstTasks({
        corpus,
        runTask,
        ...(deps.trialsPerTask !== undefined ? { trialsPerTask: deps.trialsPerTask } : {}),
        deadlineAt: Date.now() + budgetMinutes * 60_000,
        ...(calibration ? { calibration } : {}),
        alpha,
        ...(deps.maxTokenDelta !== undefined ? { maxTokenDelta: deps.maxTokenDelta } : {}),
      });
      // A MEASURED verdict spends one attempt; holds for budget, runner,
      // corpus size or a never-opened skill do not.
      if (DECISIVE_VERDICTS.has(verdict.reason)) {
        meta.gateAttempts = attemptsSoFar + 1;
        await atomicWriteJson(path.join(stagedDir, ".evolution-meta.json"), meta);
      }
      // Feed the calibration for next time with what the incumbent arm did
      // on every task that actually ran (memo hits included: they are real
      // incumbent outcomes on this model).
      if (deps.trialCache && verdict.perTask) {
        for (const t of verdict.perTask) {
          deps.trialCache.recordIncumbentTaskStats(
            t.id,
            modelTagForStats,
            t.incumbent * t.trials,
            t.trials,
          );
        }
      }
      verdictAccepted = verdict.accepted;
      const reads = verdict.candidateReadRate;
      verdictDetail = `tasks: ${verdict.reason}; incumbent ${((verdict.incumbentPassRate ?? 0) * 100).toFixed(0)}% vs candidate ${((verdict.candidatePassRate ?? 0) * 100).toFixed(0)}% (n=${verdict.trials}, K=${verdict.trialsPerTask ?? 1}, wins=${verdict.wins ?? 0}/losses=${verdict.losses ?? 0}, p=${verdict.pValue !== undefined ? verdict.pValue.toFixed(4) : "n/a"} at alpha=${alpha}, attempt ${attemptsSoFar + 1}/${MAX_GATE_ATTEMPTS}, reads cap=${reads?.capability ?? "n/a"}/reg=${reads?.regression ?? "n/a"}, tokenDelta=${verdict.tokenDelta !== undefined ? verdict.tokenDelta.toFixed(2) : "n/a"}, cached=${cachedIncumbentTrials}i/${cachedCandidateTrials}c, corpus ${verdict.corpusVersion})`;
      validationRecord = {
        mode: "tasks",
        verdict: verdict.reason,
        ...(verdict.meanDelta !== undefined ? { meanDelta: verdict.meanDelta } : {}),
        ...(verdict.ci95Low !== undefined ? { ci95Low: verdict.ci95Low } : {}),
        ...(verdict.ci95High !== undefined ? { ci95High: verdict.ci95High } : {}),
        ...(verdict.pValue !== undefined ? { pValue: verdict.pValue } : {}),
        ...(verdict.wins !== undefined ? { wins: verdict.wins } : {}),
        ...(verdict.losses !== undefined ? { losses: verdict.losses } : {}),
        trials: verdict.trials,
        ...(verdict.trialsPerTask !== undefined ? { trialsPerTask: verdict.trialsPerTask } : {}),
        corpusVersion: verdict.corpusVersion,
        corpusSeed,
        ...(verdict.candidateReadRate ? { candidateReadRate: verdict.candidateReadRate } : {}),
        ...(verdict.tokens ? { tokens: verdict.tokens } : {}),
        ...(verdict.calibrationDropped ? { calibrationDropped: verdict.calibrationDropped } : {}),
        alpha,
        ...(excludedTasks.length > 0 ? { excludedTasks } : {}),
        ...(verdict.sequential ? { sequential: verdict.sequential } : {}),
        ...(verdict.tokenDelta !== undefined ? { tokenDelta: verdict.tokenDelta } : {}),
        ...(verdict.maxTokenDelta !== undefined ? { maxTokenDelta: verdict.maxTokenDelta } : {}),
        ...(verdict.wallMs ? { wallMs: verdict.wallMs } : {}),
        ...(verdict.perTask
          ? {
              perTask: verdict.perTask.map((t) => ({
                id: t.id,
                suite: t.suite,
                incumbent: t.incumbent,
                candidate: t.candidate,
                credited: t.credited,
                trials: t.trials,
              })),
            }
          : {}),
        cachedIncumbentTrials,
        validatedAt: Date.now(),
        ...(deps.modelTag ? { model: deps.modelTag } : {}),
      };
    }
  }
  if (!validationRecord) {
    if (!deps.journal || !deps.llmCall) {
      // No way to validate: HOLD staged (never promote unvalidated — F7).
      return { skillName: name, outcome: "held", detail: "no journal/llm for validation" };
    }
    const verdict = await validateAgainstRecords({
      journal: deps.journal,
      llmCall: deps.llmCall,
      candidateName: name,
      candidateContent: staged.content,
      incumbentContent: incumbent,
    });
    // PLAN-45 2.8 (D-7): an LLM counterfactual over past traces is a
    // DIAGNOSTIC, never a verdict. Whatever the judge says, the proposal
    // HOLDS as `records-only-evidence` until a real rollout can measure it;
    // the judge's opinion is kept on the meta for the evidence record.
    verdictAccepted = false;
    meta.recordsJudge = {
      verdict: verdict.reason,
      ...(verdict.meanDelta !== undefined ? { meanDelta: verdict.meanDelta } : {}),
      ...(verdict.ci95Low !== undefined ? { ci95Low: verdict.ci95Low } : {}),
      ...(verdict.ci95High !== undefined ? { ci95High: verdict.ci95High } : {}),
      trials: verdict.trials,
      at: Date.now(),
    };
    verdictDetail = `records: records-only-evidence (judge said ${verdict.reason}; model-predicted evidence cannot promote or reject; n=${verdict.trials}${verdict.ci95Low !== undefined ? `, ci95Low=${verdict.ci95Low.toFixed(3)}` : ""})${modeSource === "config" ? " [validationMode records is deprecated; tasks mode is the gate]" : ""}${verdictDetail ? `; ${verdictDetail}` : ""}`;
    validationRecord = {
      mode: "records",
      verdict: "records-only-evidence",
      ...(verdict.meanDelta !== undefined ? { meanDelta: verdict.meanDelta } : {}),
      ...(verdict.ci95Low !== undefined ? { ci95Low: verdict.ci95Low } : {}),
      ...(verdict.ci95High !== undefined ? { ci95High: verdict.ci95High } : {}),
      trials: verdict.trials,
      validatedAt: Date.now(),
      ...(deps.modelTag ? { model: deps.modelTag } : {}),
    };
  }

  if (!verdictAccepted) {
    // Insufficient data is a HOLD (retry when the node has more held-out
    // traces), a measured non-improvement is a REJECT (discard candidate).
    const insufficient =
      validationRecord.verdict === "insufficient-trials" ||
      validationRecord.verdict === "insufficient-tasks" ||
      // The corpus has no capability tasks yet: it cannot detect
      // improvement, only regressions. HOLD and retry as the suite grows.
      validationRecord.verdict === "no-capability-tasks" ||
      validationRecord.verdict === "insufficient-capability-tasks" ||
      validationRecord.verdict === "insufficient-evidence" ||
      validationRecord.verdict === "records-only-evidence" ||
      // PLAN-44 Phase 2: the agent never opened the skill (description may
      // just need rewording) or the wall-clock budget ran out (memo makes
      // the retry cheap). Over-triggering is a measured REJECT.
      validationRecord.verdict === "never-triggered" ||
      // PLAN-45 2.5: cost is a hold (the body may be trimmed), not a reject.
      validationRecord.verdict === "cost-exceeded" ||
      validationRecord.verdict === "budget-exhausted" ||
      validationRecord.verdict === "llm-failed" ||
      validationRecord.verdict === "scoring-parse-failed" ||
      validationRecord.verdict === "runner-failed";
    const gateStats = {
      pValue: validationRecord.pValue ?? null,
      wins: validationRecord.wins ?? null,
      losses: validationRecord.losses ?? null,
      meanDelta: validationRecord.meanDelta ?? null,
      readRate: validationRecord.candidateReadRate?.capability ?? null,
      tokenDelta: validationRecord.tokenDelta ?? null,
    };
    if (insufficient) {
      await atomicWriteJson(path.join(stagedDir, ".evolution-meta.json"), {
        ...meta,
        lastValidation: {
          at: Date.now(),
          verdict: validationRecord.verdict,
          contentHash,
          corpusPrefix,
          modelTag: deps.modelTag ?? "unknown",
        },
      } satisfies EvolutionMeta);
      // PLAN-45 2.6: a hold is lineage memory too (the proposer sees why).
      await appendImpactEntry(
        {
          source: "evolution",
          action: "validate",
          skillName: name,
          verdict: "held",
          detail: verdictDetail,
          contentHash,
          stats: gateStats,
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
          ...(deps.modelTag ? { model: deps.modelTag } : {}),
        },
        trailOpts,
      );
      // PLAN-44 Phase 4a: a never-triggered HOLD is a routing failure, not
      // a body failure. Reword the description now (cheap: LLM calls, no
      // agent turns); the repaired content re-measures on the next pass
      // under a new content hash.
      if (
        validationRecord.verdict === "never-triggered" &&
        deps.descriptionRepair !== false &&
        deps.llmCall &&
        corpus &&
        (meta.descriptionRepairs ?? 0) < MAX_DESCRIPTION_REPAIRS &&
        // PLAN-45 2.4: a repair re-keys the content hash (fresh measurement)
        // but never buys an extra attempt past the lineage cap.
        attemptsSoFar < MAX_GATE_ATTEMPTS &&
        // Adversarial H3: with no grown tasks the only "relevant" tasks are
        // the public families; rewording a description to fire on ledger or
        // log tasks is exactly the overfit pressure the repair must not add.
        relevantCapabilityTasks(corpus.tasks).some((t) => !isCanonicalTask(t))
      ) {
        const repair = await repairDescription({
          llmCall: deps.llmCall,
          skillName: name,
          skillMd: staged.content,
          tasks: corpus.tasks,
          liveIndex: await listLiveSkillIndex(roots),
        }).catch((err) => ({
          applied: false as const,
          reason: `repair threw: ${String(err)}`,
          from: "",
          candidates: [],
          llmCalls: 0,
        }));
        if (repair.applied && repair.skillMd && repair.to) {
          await atomicWriteFile(stagingSkillPath(roots, name), repair.skillMd);
          const repairedHash = hashProposalContent(repair.skillMd);
          const current = (await readEvolutionMeta(stagedDir)) ?? meta;
          await atomicWriteJson(path.join(stagedDir, ".evolution-meta.json"), {
            ...current,
            contentHash: repairedHash,
            descriptionRepairs: (meta.descriptionRepairs ?? 0) + 1,
            descriptionRepairLog: [
              ...(meta.descriptionRepairLog ?? []),
              { at: Date.now(), from: repair.from, to: repair.to, reason: repair.reason },
            ],
          } satisfies EvolutionMeta);
          await appendImpactEntry(
            {
              source: "evolution",
              action: "validate",
              skillName: name,
              verdict: "staged",
              detail: `description repaired after never-triggered (${repair.reason}); re-measure next pass. from="${repair.from.slice(0, 120)}" to="${repair.to.slice(0, 120)}"`,
              contentHash: repairedHash,
              ...(deps.iteration ? { iteration: deps.iteration } : {}),
            },
            trailOpts,
          );
          log.info(`description repaired for ${name}: ${repair.reason}`);
          return {
            skillName: name,
            outcome: "held",
            detail: `${verdictDetail}; description repaired (${repair.reason}), re-measure next pass`,
          };
        }
        log.info(`description repair skipped for ${name}: ${repair.reason}`);
        return {
          skillName: name,
          outcome: "held",
          detail: `${verdictDetail}; description repair not applied (${repair.reason})`,
        };
      }
      return { skillName: name, outcome: "held", detail: verdictDetail };
    }
    await discardStaged(roots, name);
    await appendImpactEntry(
      {
        source: "evolution",
        action: "validate",
        skillName: name,
        verdict: "rejected",
        detail: verdictDetail,
        // PLAN-45 2.6: the rejected content and the statistics survive the
        // discard, so the next proposer is told what lost and by how much.
        diff: staged.content,
        stats: gateStats,
        contentHash,
        ...(typeof validationRecord.meanDelta === "number"
          ? { score: validationRecord.meanDelta }
          : {}),
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
        ...(deps.modelTag ? { model: deps.modelTag } : {}),
      },
      trailOpts,
    );
    return { skillName: name, outcome: "rejected", detail: verdictDetail };
  }

  // ACCEPT: read provenance sidecars BEFORE promote (promote discards
  // staging), promote, then write them into the live dir.
  let purposeMd: string | null = null;
  try {
    purposeMd = await fs.readFile(path.join(stagedDir, "PURPOSE.md"), "utf-8");
  } catch {
    purposeMd = null;
  }
  const promoted = await promoteStaged(
    { storageRoots: roots },
    {
      name,
      reason: `validation gate accept (${mode})`,
      author: "evolution",
      // PLAN-44 Phase 3: the validation gate is the ONE path allowed to
      // promote evolution-staged content.
      allowEvolutionStaged: true,
    },
  );
  if (!promoted.ok) {
    return {
      skillName: name,
      outcome: "error",
      detail: promoted.detail ?? promoted.error ?? "promote failed after accept",
    };
  }
  const liveDir = liveSkillDir(roots, name);
  // PLAN-45 Phase 3.1/3.2: a promotion lands in CANARY, not in service for
  // every run. The registry withholds it from a hash-bucketed share of runs
  // (the control cohort); the monitor graduates, rolls back or retires it.
  const promotedAt = Date.now();
  const enrichedMeta: EvolutionMeta = {
    ...meta,
    validation: validationRecord,
    promotedFrom: promoted.previousArchived?.version ?? null,
    ladder: {
      state: "canary",
      at: promotedAt,
      by: "gate",
      reason: `validation gate accept (${mode})`,
      previous: meta.ladder?.state ?? "staged",
    },
    canary: { startedAt: promotedAt, bucketFraction: DEFAULT_CANARY_FRACTION, reason: "gate" },
  };
  // A re-promotion of the same lineage starts a fresh window: the old
  // published marker described different bytes.
  delete enrichedMeta.published;
  delete enrichedMeta.retracted;
  delete enrichedMeta.modelDrift;
  await atomicWriteJson(path.join(liveDir, ".evolution-meta.json"), enrichedMeta);
  try {
    await registerCanary(
      name,
      {
        startedAt: promotedAt,
        bucketFraction: DEFAULT_CANARY_FRACTION,
        descriptionAtStart: skillDescription(promoted.liveContent ?? "") ?? "",
        reason: "gate",
      },
      trailOpts,
    );
  } catch (err) {
    log.warn(`canary registration failed for ${name}: ${String(err)}`);
  }
  if (purposeMd) {
    const stamped = `${purposeMd.replace(/\n+$/, "")}\n\n## Validation\n\n- ${new Date().toISOString()}: mode=${validationRecord.mode} verdict=${validationRecord.verdict}${validationRecord.ci95Low !== undefined ? ` ci95Low=${validationRecord.ci95Low.toFixed(3)}` : ""}${validationRecord.corpusVersion ? ` corpus=${validationRecord.corpusVersion}` : ""}${validationRecord.model ? ` model=${validationRecord.model}` : ""}\n`;
    await atomicWriteFile(path.join(liveDir, "PURPOSE.md"), stamped);
  }
  await appendImpactEntry(
    {
      source: "evolution",
      action: "validate",
      skillName: name,
      verdict: "accepted",
      detail: `${verdictDetail}; promoted (previous v${promoted.previousArchived?.version ?? "none"})`,
      contentHash,
      ...(typeof validationRecord.meanDelta === "number"
        ? { score: validationRecord.meanDelta }
        : {}),
      ...(deps.iteration ? { iteration: deps.iteration } : {}),
      ...(deps.modelTag ? { model: deps.modelTag } : {}),
    },
    trailOpts,
  );
  bumpSkillsSnapshotVersion({ reason: "manual", changedPath: path.join(liveDir, "SKILL.md") });
  log.info(`validation gate PROMOTED ${name} (${verdictDetail})`);
  return { skillName: name, outcome: "promoted", detail: verdictDetail };
}
