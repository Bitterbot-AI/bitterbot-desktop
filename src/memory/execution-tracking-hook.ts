/**
 * Execution Tracking Hook: an `after_tool_call` plugin hook that feeds
 * tool execution outcomes into the SkillExecutionTracker.
 *
 * This is the primary data-ingestion point for the autoresearch loop:
 * every tool call is matched against existing skill crystals, and when
 * a match is found the outcome is recorded so that the dream engine's
 * research mode has empirical data to work with.
 */

import type { DatabaseSync } from "node:sqlite";
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from "../plugins/types.js";
import type { ExecutionOutcome } from "./crystal-types.js";
import type { HormonalStateManager } from "./hormonal.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/exec-hook");

/**
 * Compute a reward score (0-1) from the tool call result.
 *
 * - 1.0 for a successful call
 * - 0.0 for an error
 * - 0.5-0.8 scaled by result content length (for non-error, non-trivial results)
 */
export function computeReward(result: unknown, error: string | undefined): number {
  if (error) {
    return 0.0;
  }
  if (result == null) {
    return 0.5;
  }

  const str = typeof result === "string" ? result : JSON.stringify(result);
  const len = str.length;

  if (len === 0) {
    return 0.5;
  }
  if (len < 50) {
    return 0.6;
  }
  if (len < 200) {
    return 0.7;
  }
  return 0.8;
}

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
    const row = db
      .prepare(
        `SELECT id FROM chunks
         WHERE (COALESCE(semantic_type, 'general') = 'skill'
                OR COALESCE(memory_type, 'plaintext') = 'skill')
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
           AND (skill_category = ? OR skill_category = ? OR text LIKE '%' || ? || '%')
         LIMIT 1`,
      )
      .get(normalized, toolName, normalized) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Create an `after_tool_call` hook handler that records executions
 * to the SkillExecutionTracker.
 */
export function createExecutionTrackingHook(
  tracker: SkillExecutionTracker,
  db: DatabaseSync,
  hormonalManager?: HormonalStateManager | null,
): (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void {
  return (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
    try {
      const reward = computeReward(event.result, event.error);

      // Hormonal events from tool outcomes — personality reacts in real-time
      if (hormonalManager) {
        if (event.error) {
          hormonalManager.stimulate("error");
        } else if (reward >= 0.7) {
          hormonalManager.stimulate("reward");
        }
      }

      const skillId = findMatchingSkill(db, event.toolName);
      if (!skillId) {
        return;
      }

      const execId = tracker.startExecution(skillId, ctx.sessionKey);

      const outcome: ExecutionOutcome = {
        success: !event.error,
        rewardScore: reward,
        errorType: event.error ? "tool_error" : null,
        errorDetail: event.error ?? null,
        executionTimeMs: event.durationMs,
        toolCallsCount: 1,
      };

      tracker.completeExecution(execId, outcome);
    } catch (err) {
      log.debug(`execution tracking hook failed: ${String(err)}`);
    }
  };
}
