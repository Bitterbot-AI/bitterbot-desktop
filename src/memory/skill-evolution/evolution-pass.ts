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
import type { SamplerStats } from "./types.js";
import type { WikiStoreOptions } from "./wiki-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";
import { type LlmCallFn, type MaintenanceResult, runWikiMaintenance } from "./maintainer.js";
import { type ApplyProposalResult, applyProposal } from "./proposal-apply.js";
import { type ProposerRunResult, runSkillProposer } from "./proposer.js";
import { readSamplerCursor, sampleIteration, writeSamplerCursor } from "./sampler.js";

const log = createSubsystemLogger("skill-evolution/pass");

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
  storeOpts?: WikiStoreOptions;
}

export interface EvolutionPassResult {
  ran: boolean;
  reason?: "no-journal" | "no-llm" | "no-new-traces" | "maintainer-parse-failed";
  samplerStats?: SamplerStats;
  maintenance?: MaintenanceResult;
  proposer?: ProposerRunResult;
  proposalOutcome?: ApplyProposalResult;
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
  const cursorBefore = await readSamplerCursor(storeOpts);
  const sample = await sampleIteration(deps.journal, {
    cursorSeq: cursorBefore,
    judgeCall: deps.judgeCall ?? deps.llmCall,
  });

  if (sample.samples.length === 0) {
    // Nothing to learn this window. Advance past the examined (excluded /
    // held-out / unknown) runs so they are not rescanned forever.
    if (sample.nextCursorSeq > cursorBefore) {
      await writeSamplerCursor(sample.nextCursorSeq, storeOpts);
    }
    return {
      ran: false,
      reason: "no-new-traces",
      samplerStats: sample.stats,
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
    log.warn("wiki maintainer output unparseable; iteration will retry next cadence window");
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
      llmCall: deps.llmCall,
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
    cursorBefore,
    cursorAfter: sample.nextCursorSeq,
  };
}
