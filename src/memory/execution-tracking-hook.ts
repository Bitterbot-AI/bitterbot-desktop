/**
 * Execution Tracking Hook: an `after_tool_call` plugin hook that feeds
 * tool execution outcomes into the SkillExecutionTracker.
 *
 * What a row here MEANS (PLAN-45 Phase 0): "a tool whose name matches a
 * skill crystal's category ran and did not report an error". That is
 * tool-level evidence (`recorded_by = 'after_tool_call'`), never a judgment
 * that the user's task succeeded. Competence consumers must not read it as
 * such; Phase 1 back-fills run-level outcomes from the event journal.
 *
 * `reward_score` is written as NULL. The previous value was a bucket of the
 * result's character count (0.5-0.8), which also fired the hormonal "reward"
 * stimulus for any response over 200 characters. A length is not a reward.
 */

import type { DatabaseSync } from "node:sqlite";
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from "../plugins/types.js";
import type { ExecutionOutcome } from "./crystal-types.js";
import type { HormonalStateManager } from "./hormonal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isA2aTaskSessionKey,
  isSkillEvolveValidationSessionKey,
} from "../sessions/session-key-utils.js";
import { RUN_EVIDENCE_WHERE, type SkillExecutionTracker } from "./skill-execution-tracker.js";

const log = createSubsystemLogger("memory/exec-hook");

/**
 * Normalize a tool name for matching against skill_category.
 * Strips prefixes like "bitterbot_" and lowercases.
 */
function normalizeToolName(name: string): string {
  return name
    .replace(/^bitterbot[_-]/i, "")
    .replace(/[_-]/g, "-")
    .toLowerCase();
}

/**
 * Try to find a matching skill crystal for a given tool name.
 * Returns the skill crystal ID if found, null otherwise.
 */
function findMatchingSkill(db: DatabaseSync, toolName: string): string | null {
  const normalized = normalizeToolName(toolName);
  try {
    // PLAN-40 Phase 2a (adversarial F6/F8): EXACT skill_category match only,
    // deterministic tie-break, dream-origin crystals excluded. The old
    // `text LIKE '%tool%' LIMIT 1` with no ORDER BY let a generic tool name
    // credit an arbitrary unrelated crystal, and dream-made paraphrase
    // crystals could absorb real executions — enabling exactly the
    // self-distillation loop Lane 1 forbids.
    const row = db
      .prepare(
        `SELECT id FROM chunks
         WHERE (COALESCE(semantic_type, 'general') = 'skill'
                OR COALESCE(memory_type, 'plaintext') = 'skill')
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
           AND COALESCE(origin, '') != 'dream'
           AND (skill_category = ? OR skill_category = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(normalized, toolName) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Publish maturity gate (mirrors checkBountyClaimQuality's execution floor in
 * skill-network-bridge.ts): re-attempt network publish once a skill has this
 * many completed executions with RUN-level evidence (PLAN-45 Phase 1.1: a
 * fresh hook row is never counted; the back-fill stamps earlier runs).
 */
const PUBLISH_MATURITY_EXECUTIONS = 3;

/**
 * Create an `after_tool_call` hook handler that records executions
 * to the SkillExecutionTracker.
 *
 * `onMaturedUnpublished` closes audit F5: network publish used to fire ONLY
 * at crystallization time, when a crystal has zero executions by construction
 * — so the ≥3-execution maturity gate rejected it and nothing ever re-tried,
 * leaving every matured skill local forever. Execution-recording is the one
 * moment a skill can CROSS the gate, so that is where the re-attempt lives.
 * The callback target (publishCrystalSkill) re-runs the full gate chain
 * (governance, provenance, verifier, maturity) and no-ops when not ready, so
 * over-calling is safe.
 */
export function createExecutionTrackingHook(
  tracker: SkillExecutionTracker,
  db: DatabaseSync,
  hormonalManager?: HormonalStateManager | null,
  onMaturedUnpublished?: (skillCrystalId: string) => void,
): (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void {
  return (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
    try {
      // PLAN-43 Phase 1 (R2): a remote A2A caller's turn must not move
      // node state — no hormonal stimulation, no skill execution records,
      // no steering rewards, no maturity-triggered publish re-attempts.
      if (
        isA2aTaskSessionKey(ctx.sessionKey) ||
        isSkillEvolveValidationSessionKey(ctx.sessionKey)
      ) {
        return;
      }
      // Hormonal events from tool outcomes: an error is a real signal. A
      // non-error is NOT a reward (PLAN-45 Phase 0); verified task completion
      // stimulates reward through registerTaskRewardHook instead.
      if (hormonalManager && event.error) {
        hormonalManager.stimulate("error");
      }

      const skillId = findMatchingSkill(db, event.toolName);
      if (!skillId) {
        return;
      }

      const execId = tracker.startExecution(skillId, ctx.sessionKey, {
        toolName: event.toolName,
        recordedBy: "after_tool_call",
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
        evidence: "tool",
      });

      const outcome: ExecutionOutcome = {
        success: !event.error,
        rewardScore: undefined,
        errorType: event.error ? "tool_error" : null,
        errorDetail: event.error ?? null,
        executionTimeMs: event.durationMs,
        toolCallsCount: 1,
      };

      tracker.completeExecution(execId, outcome);

      if (outcome.success && onMaturedUnpublished) {
        try {
          const mature = db
            .prepare(
              `SELECT (SELECT COUNT(*) FROM skill_executions
                        WHERE skill_crystal_id = ? AND completed_at IS NOT NULL
                          AND ${RUN_EVIDENCE_WHERE}) AS execs,
                      (SELECT published_at FROM chunks WHERE id = ?) AS published_at`,
            )
            .get(skillId, skillId) as { execs: number; published_at: number | null } | undefined;
          if (
            mature &&
            mature.execs >= PUBLISH_MATURITY_EXECUTIONS &&
            mature.published_at == null
          ) {
            onMaturedUnpublished(skillId);
          }
        } catch (err) {
          log.debug(`maturity publish re-check failed: ${String(err)}`);
        }
      }
    } catch (err) {
      log.debug(`execution tracking hook failed: ${String(err)}`);
    }
  };
}
