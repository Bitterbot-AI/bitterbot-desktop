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
 */

import type { DatabaseSync } from "node:sqlite";
import type { EventJournal } from "../../infra/event-journal.js";
import type { AgentTurnFn } from "./task-runner.js";
import type { SamplerStats } from "./types.js";
import type { WikiStoreOptions } from "./wiki-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";
import { loadEffectiveCorpus } from "./canonical-corpus.js";
import { mineCapabilityTasks } from "./corpus-miner.js";
import { type LlmCallFn, type MaintenanceResult, runWikiMaintenance } from "./maintainer.js";
import {
  publishEligibleEvolvedSkills,
  type PublishSweepResult,
  type SkillPublisher,
} from "./p2p-publish.js";
import { type ApplyProposalResult, applyProposal } from "./proposal-apply.js";
import { type ProposerRunResult, runSkillProposer } from "./proposer.js";
import { readSamplerCursor, sampleIteration, writeSamplerCursor } from "./sampler.js";
import { runValidationGate, type ValidationGateOutcome } from "./validation-gate.js";
import { runWikiLint, type WikiLintResult } from "./wiki-lint.js";
import {
  readSemanticLintState,
  runSemanticLint,
  type SemanticLintResult,
} from "./wiki-semantic-lint.js";

const log = createSubsystemLogger("skill-evolution/pass");

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
  maxActiveEvolved?: number;
  modelTag?: string;
  /** P2P propagation (Phase 5). Publisher = the orchestrator bridge or a fake. */
  propagate?: boolean;
  maturityDays?: number;
  publisher?: SkillPublisher | null;
  /** Tasks-mode real-rollout executor (validation gate builds the paired runner). */
  agentTurn?: AgentTurnFn;
  /** Dedicated proposer model lane (stronger than the maintainer/cheap lane). */
  proposerLlmCall?: LlmCallFn;
  /** Min days between semantic (LLM) wiki lint passes. Default 7; 0 disables. */
  semanticLintCadenceDays?: number;
  storeOpts?: WikiStoreOptions;
}

export interface EvolutionPassResult {
  ran: boolean;
  reason?: "no-journal" | "no-llm" | "no-new-traces" | "maintainer-parse-failed";
  samplerStats?: SamplerStats;
  maintenance?: MaintenanceResult;
  proposer?: ProposerRunResult;
  proposalOutcome?: ApplyProposalResult;
  validation?: ValidationGateOutcome[];
  lint?: WikiLintResult;
  semanticLint?: SemanticLintResult;
  publish?: PublishSweepResult;
  cursorBefore?: number;
  cursorAfter?: number;
}

/** Run one evolution iteration. Never throws — evolution must not break dreams. */
export async function runEvolutionIteration(deps: EvolutionPassDeps): Promise<EvolutionPassResult> {
  try {
    return await runEvolutionIterationInner(deps);
  } catch (err) {
    log.warn(`evolution iteration failed: ${String(err)}`);
    return { ran: false };
  }
}

async function runEvolutionIterationInner(deps: EvolutionPassDeps): Promise<EvolutionPassResult> {
  if (!deps.journal) {
    return { ran: false, reason: "no-journal" };
  }
  if (!deps.llmCall) {
    return { ran: false, reason: "no-llm" };
  }
  const storeOpts = deps.storeOpts ?? {};
  let cursorBefore = await readSamplerCursor(storeOpts);
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
  });

  if (sample.samples.length === 0) {
    // Nothing to learn this window. Advance past the examined (excluded /
    // held-out / unknown) runs so they are not rescanned forever. Held
    // proposals, lint, and matured publishes still get their sweep —
    // eligibility ripens with time, not with new traces.
    if (sample.nextCursorSeq > cursorBefore) {
      await writeSamplerCursor(sample.nextCursorSeq, storeOpts);
    }
    const housekeeping = deps.runProposer !== false ? await runHousekeeping(deps, storeOpts) : {};
    return {
      ran: false,
      reason: "no-new-traces",
      samplerStats: sample.stats,
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
    // Unparseable output: write nothing, keep the cursor so the same window
    // is retried next iteration (bounded by the cadence gate).
    log.warn(
      `wiki maintainer output unparseable; iteration will retry next cadence window` +
        (maintenance.parseIssues?.length
          ? ` (issues: ${maintenance.parseIssues.join("; ").slice(0, 300)})`
          : "") +
        (maintenance.rawSample
          ? ` (raw: ${maintenance.rawSample.replace(/\s+/g, " ").slice(0, 300)})`
          : ""),
    );
    return {
      ran: true,
      reason: "maintainer-parse-failed",
      samplerStats: sample.stats,
      maintenance,
      cursorBefore,
      cursorAfter: cursorBefore,
    };
  }

  await writeSamplerCursor(sample.nextCursorSeq, storeOpts);

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
    proposer = await runSkillProposer({
      llmCall: deps.proposerLlmCall ?? deps.llmCall,
      samples: sample.samples,
      ...(deps.storeOpts ? { storeOpts: deps.storeOpts } : {}),
      ...(deps.maxProposerTurns ? { maxTurns: deps.maxProposerTurns } : {}),
      ...(deps.db ? { db: deps.db } : {}),
      journal: deps.journal,
    });
    proposalOutcome = await applyProposal(proposer.proposal, {
      ...(deps.storeOpts ? { storeOpts: deps.storeOpts } : {}),
      iteration: deps.cycleId ?? new Date().toISOString().slice(0, 10),
    });
  }

  // Corpus miner (2026-09-02 upgrade): draft capability-suite tasks from
  // this window's FAILING traces into the pending-review file. Best-effort
  // and draft-only — nothing enters the live corpus without human review.
  try {
    const failingTexts = sample.samples
      .filter((s) => s.label.label === "fail")
      .map((s) => s.formattedLog);
    if (failingTexts.length > 0) {
      const effective = await loadEffectiveCorpus(storeOpts);
      await mineCapabilityTasks({
        failingTraceTexts: failingTexts,
        llmCall: deps.llmCall,
        existingIds: new Set((effective?.tasks ?? []).map((t) => t.id)),
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
    `evolution iteration: ${sample.samples.length} traces (${sample.stats.failsSelected}f/${sample.stats.passesSelected}p) -> ` +
      `${maintenance.apply?.created.length ?? 0} patterns created, ${maintenance.apply?.updated.length ?? 0} updated, ` +
      `${maintenance.apply?.dropped.length ?? 0} dropped` +
      (proposer
        ? `; proposal: ${proposer.proposal.action} (${proposalOutcome?.outcome ?? "?"}, ${proposer.turns} turns)`
        : ""),
  );
  return {
    ran: true,
    samplerStats: sample.stats,
    maintenance,
    ...(proposer ? { proposer } : {}),
    ...(proposalOutcome ? { proposalOutcome } : {}),
    ...housekeeping,
    cursorBefore,
    cursorAfter: sample.nextCursorSeq,
  };
}

/**
 * Validation gate (settles held + new proposals), wiki lint, and the P2P
 * publish sweep. Runs on every iteration attempt — held proposals and
 * publish eligibility ripen with time even when no new traces arrive.
 */
async function runHousekeeping(
  deps: EvolutionPassDeps,
  storeOpts: WikiStoreOptions,
): Promise<{
  validation?: ValidationGateOutcome[];
  lint?: WikiLintResult;
  semanticLint?: SemanticLintResult;
  publish?: PublishSweepResult;
}> {
  const validation = await runValidationGate({
    journal: deps.journal,
    llmCall: deps.llmCall,
    ...(storeOpts.configDir ? { storeOpts } : {}),
    ...(deps.validationMode ? { mode: deps.validationMode } : {}),
    ...(typeof deps.trialsPerTask === "number" ? { trialsPerTask: deps.trialsPerTask } : {}),
    ...(deps.agentTurn ? { agentTurn: deps.agentTurn } : {}),
    ...(deps.maxActiveEvolved ? { maxActiveEvolved: deps.maxActiveEvolved } : {}),
    ...(deps.modelTag ? { modelTag: deps.modelTag } : {}),
    iteration: deps.cycleId ?? new Date().toISOString().slice(0, 10),
  });
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
    validation,
    ...(lint ? { lint } : {}),
    ...(semanticLint ? { semanticLint } : {}),
    ...(publish ? { publish } : {}),
  };
}
