/**
 * Judge LLM provider wiring (PLAN-17 Phase 1).
 *
 * Connects the abstract `LlmCall` seam in `src/tasks/judge.ts` to a real
 * provider. A judge round is a single completion — no streaming, no
 * tools, no session history — so we bypass `pi-coding-agent`'s session
 * machinery and call `completeSimple` from `@mariozechner/pi-ai`
 * directly, matching the pattern in `src/agents/tools/deep-recall-tool.ts:122`.
 *
 * Model selection precedence:
 *   1. BITTERBOT_TASKS_JUDGE_MODEL env override (provider/model)
 *   2. config.agents.defaults.model.primary
 *   3. anthropic/claude-opus-4-8 (matches `src/config/defaults.ts:16`)
 *
 * Sampling: NO temperature/top_p/top_k are sent — `temperature` is removed
 * on Opus 4.7+/Sonnet 5/Fable 5 and the API 400s any value (that 400 was
 * silently masked as "model returned no text content" until 2026-07-21).
 * Determinism/creativity is steered by the prompt. Max tokens 600 — a
 * verdict is <= 60 words plus a short `missing[]` list, so 600 is generous.
 *
 * Retry envelope: 3 attempts with exponential backoff on rate limits,
 * 5xx responses, and transient network errors. Parse failures bubble up
 * to `runTaskJudge` which already returns null on unparseable output.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { LlmCall } from "./judge.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerJudgeLlmCall, registerJudgeModel } from "./judge.js";

const log = createSubsystemLogger("tasks/judge-provider");

const DEFAULT_JUDGE_MODEL = "anthropic/claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 600;
const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;

export type JudgeProviderOptions = {
  /** Defaults to env BITTERBOT_TASKS_JUDGE_MODEL or config primary. */
  modelRef?: string;
  maxTokens?: number;
  /** How many total attempts before giving up. Default 3. */
  attempts?: number;
  /** Test seam: sleep impl. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Build the JudgeLlmCall. Returns the callable; does NOT register it
 * — callers (typically `server.impl.ts`) call `registerJudgeLlmCall`.
 */
export function createJudgeLlmCall(
  cfg: BitterbotConfig | undefined,
  opts: JudgeProviderOptions = {},
): LlmCall {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (prompt: string): Promise<string> => {
    const modelRef = resolveModelRef(cfg, opts.modelRef);
    const { provider, modelId } = splitModelRef(modelRef);

    const { completeAttributed } = await import("../agents/complete-attributed.js");

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        // PLAN-50: completeAttributed records usage (including failed attempts) in the ledger
        // and surfaces the REAL provider error rather than masking it as "no text content".
        const { text } = await completeAttributed({
          provider,
          modelId,
          cfg,
          prompt,
          maxTokens,
          feature: "tasks/judge",
          errorPrefix: "judge-provider",
          // The judge is user-facing task verification, never paused by a budget.
          ignoreBudget: true,
        });
        if (!text) {
          throw new Error("judge-provider: model returned no text content");
        }
        return text;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === attempts - 1) {
          break;
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        log.warn(
          `judge-provider attempt ${attempt + 1}/${attempts} failed (${describeError(err)}); ` +
            `retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/**
 * Convenience: build the call and register it as the active judge.
 * Returns true when registration happened, false when no Anthropic key
 * is available (judge stays unregistered; `task_judge` will report
 * `judge LLM call is not registered`).
 */
export function registerJudgeFromConfig(
  cfg: BitterbotConfig | undefined,
  opts: JudgeProviderOptions = {},
): boolean {
  try {
    const llm = createJudgeLlmCall(cfg, opts);
    registerJudgeLlmCall(llm);
    registerJudgeModel(resolveModelRef(cfg, opts.modelRef));
    log.info(`judge LLM registered (model=${resolveModelRef(cfg, opts.modelRef)})`);
    return true;
  } catch (err) {
    log.warn(`judge LLM registration failed: ${describeError(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function resolveModelRef(cfg: BitterbotConfig | undefined, override?: string): string {
  if (override) return override;
  const envOverride = process.env.BITTERBOT_TASKS_JUDGE_MODEL?.trim();
  if (envOverride) return envOverride;
  const primary = cfg?.agents?.defaults?.model?.primary;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  return DEFAULT_JUDGE_MODEL;
}

function splitModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf("/");
  if (idx < 0) {
    return { provider: "anthropic", modelId: ref };
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = describeError(err).toLowerCase();
  if (msg.includes("rate") || msg.includes("429")) return true;
  if (msg.includes("timeout") || msg.includes("etimedout")) return true;
  if (msg.includes("econnreset") || msg.includes("econnrefused")) return true;
  if (msg.includes("socket hang up")) return true;
  for (let i = 500; i < 600; i += 1) {
    if (msg.includes(`${i}`)) return true;
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
