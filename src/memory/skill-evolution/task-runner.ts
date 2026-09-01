/**
 * PLAN-42 Phase 4 (tasks mode): the real-rollout runner.
 *
 * The paper validates a candidate skill by ACTUALLY RUNNING the agent on
 * held-out tasks with the candidate installed and comparing outcomes. This
 * builds that runner. Two design choices keep it faithful and safe:
 *
 *   - Full injection (matches the paper): the candidate / incumbent skill
 *     body is injected into the task prompt, exactly as the paper injects
 *     active skills into the Inference Agent's system prompt. No disk
 *     mutation, no profile juggling — the two arms differ only by the
 *     injected skill text, which is precisely the variable under test.
 *   - Dependency-injected executor: `AgentTurnFn` runs one real agent turn
 *     and returns its final answer. The gateway-RPC adapter is the
 *     production executor; tests inject a deterministic fake.
 */

import type { CorpusTask } from "./task-corpus.js";
import type { TaskRunnerFn, TaskVariant } from "./validate-tasks.js";

/** Runs one real agent turn on a throwaway session; returns the final answer. */
export type AgentTurnFn = (prompt: string, opts?: { timeoutMs?: number }) => Promise<string>;

const SKILL_INJECTION_HEADER =
  "You have access to the following skill. Read it and apply its guidance if it is relevant to the task:";

export function composeTaskPrompt(task: CorpusTask, skillBody: string | null): string {
  if (!skillBody) {
    return task.prompt;
  }
  return `${SKILL_INJECTION_HEADER}\n\n--- BEGIN SKILL ---\n${skillBody}\n--- END SKILL ---\n\n${task.prompt}`;
}

/**
 * Build a paired TaskRunnerFn for one candidate-vs-incumbent comparison.
 * `candidateContent` is the staged skill; `incumbentContent` is the current
 * live skill (or null for a create — the incumbent arm then runs with no
 * skill injected, i.e. the agent as it is today).
 */
export function makeInjectedSkillRunner(
  agentTurn: AgentTurnFn,
  candidateContent: string,
  incumbentContent: string | null,
): TaskRunnerFn {
  return async (task: CorpusTask, variant: TaskVariant): Promise<string> => {
    const body = variant === "candidate" ? candidateContent : incumbentContent;
    const prompt = composeTaskPrompt(task, body);
    return agentTurn(prompt, task.timeoutMs ? { timeoutMs: task.timeoutMs } : {});
  };
}

/** Shape of the gateway `agent` RPC response (subset we consume). */
interface AgentRpcResponse {
  status?: string;
  result?: { payloads?: Array<{ text?: string }> };
}

export interface GatewayAgentTurnDeps {
  callGateway: (args: {
    method: string;
    params: unknown;
    expectFinal?: boolean;
    timeoutMs?: number;
  }) => Promise<unknown>;
  agentId: string;
  channel: string;
  makeSessionKey: () => string;
  makeIdempotencyKey: () => string;
  defaultTimeoutMs?: number;
}

/**
 * Production executor: one real agent turn via the gateway `agent` RPC on a
 * throwaway, non-delivering session (the doctor-agent-turn pattern). Returns
 * the concatenated final answer text, or "" on a non-ok status.
 */
export function makeGatewayAgentTurn(deps: GatewayAgentTurnDeps): AgentTurnFn {
  return async (prompt, opts) => {
    const timeoutMs = opts?.timeoutMs ?? deps.defaultTimeoutMs ?? 120_000;
    const resp = (await deps.callGateway({
      method: "agent",
      params: {
        message: prompt,
        agentId: deps.agentId,
        sessionKey: deps.makeSessionKey(),
        deliver: false,
        channel: deps.channel,
        timeout: Math.ceil(timeoutMs / 1000),
        idempotencyKey: deps.makeIdempotencyKey(),
      },
      expectFinal: true,
      timeoutMs: timeoutMs + 5_000,
    })) as AgentRpcResponse;
    if (resp?.status !== "ok") {
      throw new Error(`agent turn returned status "${resp?.status ?? "none"}"`);
    }
    return (resp.result?.payloads ?? [])
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
  };
}
