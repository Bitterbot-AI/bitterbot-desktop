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
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
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
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deriveCanonicalSeed, loadEffectiveCorpus } from "./canonical-corpus.js";
import { atomicWriteFile, atomicWriteJson } from "./fs-atomic.js";
import {
  HOLD_BACKOFF_MS,
  HOLD_BACKOFF_VERDICTS,
  memoizeTrials,
  sweepStaleTrials,
} from "./gate-support.js";
import { hashProposalContent } from "./proposal-apply.js";
import { type AgentTurnFn, makeRuntimePathwayRunner } from "./task-runner.js";
import { TrialCache } from "./trial-cache.js";
import { validateAgainstRecords } from "./validate-records.js";
import { type TaskRunnerFn, validateAgainstTasks } from "./validate-tasks.js";
import { countCapabilityTasks, resolveEffectiveValidationMode } from "./validation-mode.js";

const log = createSubsystemLogger("skill-evolution/validation-gate");

export const DEFAULT_MAX_ACTIVE_EVOLVED = 5;
/** PLAN-44 Phase 2: wall-clock budget for one tasks-mode validation run. */
export const DEFAULT_VALIDATION_BUDGET_MINUTES = 45;

export interface EvolutionMeta {
  origin: string;
  stagedAt?: number;
  iteration?: string | null;
  /** PLAN-44 Phase 3: traces the proposer read and their trust classes. */
  evidence?: { runIds: string[]; origins: string[] };
  /** PLAN-44 Phase 3: hash of the SKILL.md the pipeline staged (tamper check). */
  contentHash?: string;
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
  maxActiveEvolved?: number;
  /** Model tag recorded into the promoted skill's provenance. */
  modelTag?: string;
  iteration?: string;
  /** PLAN-44 Phase 2: wall-clock budget per tasks-mode validation (config). */
  validationBudgetMinutes?: number;
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
    if (await readEvolutionMeta(path.join(roots.liveRoot, name))) {
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
  const corpus = await loadEffectiveCorpus(trailOpts, corpusSeed);
  // PLAN-44 D-2: explicit config wins; otherwise tasks mode once the corpus
  // carries enough reviewed capability tasks for the sign test.
  const { mode } = resolveEffectiveValidationMode(deps.mode, countCapabilityTasks(corpus));
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
  if (mode === "tasks" && !runTask) {
    // Adversarial M6: the executor is built at pass start from the same
    // corpus count; if the corpus crossed the threshold mid-pass, say so.
    log.warn(`validation mode is tasks but no executor is available; falling back to records`);
    verdictDetail = "tasks mode without an executor; falling back to records";
  }
  if (mode === "tasks" && runTask) {
    if (!corpus) {
      verdictDetail = "tasks mode but no corpus available; falling back to records";
    } else {
      const budgetMinutes = deps.validationBudgetMinutes ?? DEFAULT_VALIDATION_BUDGET_MINUTES;
      const verdict = await validateAgainstTasks({
        corpus,
        runTask,
        ...(deps.trialsPerTask !== undefined ? { trialsPerTask: deps.trialsPerTask } : {}),
        deadlineAt: Date.now() + budgetMinutes * 60_000,
      });
      verdictAccepted = verdict.accepted;
      const reads = verdict.candidateReadRate;
      verdictDetail = `tasks: ${verdict.reason}; incumbent ${((verdict.incumbentPassRate ?? 0) * 100).toFixed(0)}% vs candidate ${((verdict.candidatePassRate ?? 0) * 100).toFixed(0)}% (n=${verdict.trials}, K=${verdict.trialsPerTask ?? 1}, wins=${verdict.wins ?? 0}/losses=${verdict.losses ?? 0}, p=${verdict.pValue !== undefined ? verdict.pValue.toFixed(4) : "n/a"}, reads cap=${reads?.capability ?? "n/a"}/reg=${reads?.regression ?? "n/a"}, cached=${cachedIncumbentTrials}i/${cachedCandidateTrials}c, corpus ${verdict.corpusVersion})`;
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
    verdictAccepted = verdict.accepted;
    verdictDetail = `records: ${verdict.reason} (n=${verdict.trials}${verdict.ci95Low !== undefined ? `, ci95Low=${verdict.ci95Low.toFixed(3)}` : ""})${verdictDetail ? `; ${verdictDetail}` : ""}`;
    validationRecord = {
      mode: "records",
      verdict: verdict.reason,
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
      // PLAN-44 Phase 2: the agent never opened the skill (description may
      // just need rewording) or the wall-clock budget ran out (memo makes
      // the retry cheap). Over-triggering is a measured REJECT.
      validationRecord.verdict === "never-triggered" ||
      validationRecord.verdict === "budget-exhausted" ||
      validationRecord.verdict === "llm-failed" ||
      validationRecord.verdict === "scoring-parse-failed" ||
      validationRecord.verdict === "runner-failed";
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
  const enrichedMeta: EvolutionMeta = { ...meta, validation: validationRecord };
  await atomicWriteJson(path.join(liveDir, ".evolution-meta.json"), enrichedMeta);
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
