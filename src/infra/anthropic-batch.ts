/**
 * Anthropic Message Batches for latency-tolerant lanes (token-efficiency item 3).
 *
 * One batch per lane call: POST /v1/messages/batches with a single request, poll
 * GET /v1/messages/batches/{id} with backoff until `processing_status` is "ended", stream
 * the JSONL at `results_url`, and return the message keyed by `custom_id`. Everything is
 * charged at 50% of the standard price; prompt caching works inside a batch (the docs
 * recommend the 1h TTL for shared context). On timeout, abort or any error the batch is
 * canceled (best effort, POST .../cancel) and the caller falls back to the live path.
 *
 * Verified against https://platform.claude.com/docs/en/build-with-claude/batch-processing
 * on 2026-09-20: `requests[].custom_id` (^[a-zA-Z0-9_-]{1,64}$) + `requests[].params`
 * (standard Messages params), `processing_status` in_progress | canceling | ended,
 * `request_counts.{processing,succeeded,errored,canceled,expired}`, `results_url`,
 * `expires_at` (24h), result types succeeded | errored | canceled | expired; results are
 * available for 29 days and arrive in any order. Raw HTTP on purpose: the vendored model
 * library has no batches surface, and the key/base URL come from the provider resolution
 * the live path already uses.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("infra/anthropic-batch");

export const ANTHROPIC_BATCH_DEFAULT_MAX_WAIT_MINUTES = 20;
export const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const POLL_INITIAL_MS = 3_000;
const POLL_MAX_MS = 30_000;
const POLL_FACTOR = 1.6;
/** After a submit is refused with 401/403/404, skip batching against that base URL for a while. */
const UNSUPPORTED_COOLDOWN_MS = 60 * 60_000;

export type AnthropicBatchTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

export type AnthropicBatchMessageParams = {
  model: string;
  max_tokens: number;
  system?: string | AnthropicBatchTextBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string | AnthropicBatchTextBlock[] }>;
  temperature?: number;
  stop_sequences?: string[];
};

export type AnthropicBatchUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

export type AnthropicBatchResultMessage = {
  id?: string;
  type?: "message";
  role?: "assistant";
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: AnthropicBatchUsage;
};

export type AnthropicBatchFailureReason =
  | "submit-error"
  | "poll-error"
  | "result-error"
  | "timeout"
  | "aborted"
  | "errored"
  | "canceled"
  | "expired"
  | "missing"
  | "unsupported";

export type AnthropicBatchOutcome =
  | {
      ok: true;
      message: AnthropicBatchResultMessage;
      batchId: string;
      waitedMs: number;
      polls: number;
    }
  | {
      ok: false;
      reason: AnthropicBatchFailureReason;
      error?: string;
      batchId?: string;
      waitedMs: number;
      /** True when a cancel was sent for the batch. */
      canceled: boolean;
    };

export type AnthropicBatchCallParams = {
  apiKey: string;
  baseUrl?: string;
  request: AnthropicBatchMessageParams;
  /** Wall-clock cap for submit + poll + fetch. Default 20 minutes. */
  maxWaitMs?: number;
  signal?: AbortSignal;
  customId?: string;
  /** Extra headers (provider `headers` from the model definition). */
  headers?: Record<string, string>;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollInitialMs?: number;
  pollMaxMs?: number;
};

type BatchObject = {
  id?: string;
  processing_status?: string;
  request_counts?: {
    processing?: number;
    succeeded?: number;
    errored?: number;
    canceled?: number;
    expired?: number;
  };
  results_url?: string | null;
  expires_at?: string | null;
  ended_at?: string | null;
};

const unsupportedUntil = new Map<string, number>();

export function normalizeBatchBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  // pi-ai model base URLs may already end in /v1; the batch path adds it.
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/** Whether batching should even be attempted against this base URL right now. */
export function isBatchTemporarilyUnsupported(
  baseUrl: string | undefined,
  now = Date.now(),
): boolean {
  const until = unsupportedUntil.get(normalizeBatchBaseUrl(baseUrl));
  return typeof until === "number" && until > now;
}

export function resetAnthropicBatchStateForTest(): void {
  unsupportedUntil.clear();
}

function makeCustomId(seed?: string): string {
  const base = (seed ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${base || "lane"}-${Date.now().toString(36)}-${rand}`.slice(0, 64);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

/** Parse the JSONL results body and return the line for `customId` (results arrive in any order). */
export function findBatchResultLine(
  body: string,
  customId: string,
): {
  custom_id?: string;
  result?: { type?: string; message?: AnthropicBatchResultMessage; error?: unknown };
} | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { custom_id?: string };
      if (parsed.custom_id === customId) {
        return parsed;
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}

export async function runAnthropicBatchCall(
  params: AnthropicBatchCallParams,
): Promise<AnthropicBatchOutcome> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => defaultSleep(ms, params.signal));
  const base = normalizeBatchBaseUrl(params.baseUrl);
  const maxWaitMs = params.maxWaitMs ?? ANTHROPIC_BATCH_DEFAULT_MAX_WAIT_MINUTES * 60_000;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const headers: Record<string, string> = {
    ...params.headers,
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": params.apiKey,
    "anthropic-version": ANTHROPIC_API_VERSION,
  };
  const customId = params.customId ?? makeCustomId(params.request.model);

  if (isBatchTemporarilyUnsupported(base, now())) {
    return { ok: false, reason: "unsupported", waitedMs: 0, canceled: false };
  }
  if (params.signal?.aborted) {
    return { ok: false, reason: "aborted", waitedMs: 0, canceled: false };
  }

  let batchId: string | undefined;
  const cancel = async (): Promise<boolean> => {
    if (!batchId) {
      return false;
    }
    try {
      const res = await fetchImpl(`${base}/v1/messages/batches/${batchId}/cancel`, {
        method: "POST",
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  // 1. submit
  try {
    const res = await fetchImpl(`${base}/v1/messages/batches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: [{ custom_id: customId, params: params.request }] }),
      signal: params.signal,
    });
    if (!res.ok) {
      const text = await readErrorText(res);
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        unsupportedUntil.set(base, now() + UNSUPPORTED_COOLDOWN_MS);
      }
      return {
        ok: false,
        reason: "submit-error",
        error: `HTTP ${res.status} ${text}`.trim(),
        waitedMs: elapsed(),
        canceled: false,
      };
    }
    const created = (await res.json()) as BatchObject;
    if (!created?.id) {
      return {
        ok: false,
        reason: "submit-error",
        error: "no batch id",
        waitedMs: elapsed(),
        canceled: false,
      };
    }
    batchId = created.id;
  } catch (err) {
    return {
      ok: false,
      reason: params.signal?.aborted ? "aborted" : "submit-error",
      error: err instanceof Error ? err.message : String(err),
      waitedMs: elapsed(),
      canceled: false,
    };
  }

  // 2. poll with backoff
  let delay = params.pollInitialMs ?? POLL_INITIAL_MS;
  const pollMax = params.pollMaxMs ?? POLL_MAX_MS;
  let polls = 0;
  let batch: BatchObject | null = null;
  const stopped = async (): Promise<AnthropicBatchOutcome | null> => {
    if (params.signal?.aborted) {
      const canceled = await cancel();
      return { ok: false, reason: "aborted", batchId, waitedMs: elapsed(), canceled };
    }
    if (elapsed() >= maxWaitMs) {
      const canceled = await cancel();
      return { ok: false, reason: "timeout", batchId, waitedMs: elapsed(), canceled };
    }
    return null;
  };
  for (;;) {
    const before = await stopped();
    if (before) {
      return before;
    }
    await sleep(Math.min(delay, Math.max(0, maxWaitMs - elapsed())));
    // The sleep may have consumed the deadline or been cut short by an abort.
    const after = await stopped();
    if (after) {
      return after;
    }
    delay = Math.min(pollMax, Math.round(delay * POLL_FACTOR));
    polls += 1;
    try {
      const res = await fetchImpl(`${base}/v1/messages/batches/${batchId}`, {
        method: "GET",
        headers,
        signal: params.signal,
      });
      if (!res.ok) {
        const text = await readErrorText(res);
        if (res.status >= 500 || res.status === 429) {
          continue; // transient; keep polling until the deadline
        }
        const canceled = await cancel();
        return {
          ok: false,
          reason: "poll-error",
          error: `HTTP ${res.status} ${text}`.trim(),
          batchId,
          waitedMs: elapsed(),
          canceled,
        };
      }
      batch = (await res.json()) as BatchObject;
    } catch (err) {
      if (params.signal?.aborted) {
        const canceled = await cancel();
        return { ok: false, reason: "aborted", batchId, waitedMs: elapsed(), canceled };
      }
      log.debug(
        `batch poll failed (${batchId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (batch.processing_status === "ended") {
      break;
    }
  }

  // 3. results
  const resultsUrl = batch?.results_url || `${base}/v1/messages/batches/${batchId}/results`;
  try {
    const res = await fetchImpl(resultsUrl, { method: "GET", headers, signal: params.signal });
    if (!res.ok) {
      const text = await readErrorText(res);
      return {
        ok: false,
        reason: "result-error",
        error: `HTTP ${res.status} ${text}`.trim(),
        batchId,
        waitedMs: elapsed(),
        canceled: false,
      };
    }
    const body = await res.text();
    const line = findBatchResultLine(body, customId);
    if (!line?.result) {
      return { ok: false, reason: "missing", batchId, waitedMs: elapsed(), canceled: false };
    }
    const type = line.result.type;
    if (type === "succeeded" && line.result.message) {
      return {
        ok: true,
        message: line.result.message,
        batchId: batchId!,
        waitedMs: elapsed(),
        polls,
      };
    }
    const reason: AnthropicBatchFailureReason =
      type === "errored"
        ? "errored"
        : type === "canceled"
          ? "canceled"
          : type === "expired"
            ? "expired"
            : "missing";
    const errorText = (() => {
      try {
        return JSON.stringify(line.result.error).slice(0, 300);
      } catch {
        return undefined;
      }
    })();
    return { ok: false, reason, error: errorText, batchId, waitedMs: elapsed(), canceled: false };
  } catch (err) {
    return {
      ok: false,
      reason: params.signal?.aborted ? "aborted" : "result-error",
      error: err instanceof Error ? err.message : String(err),
      batchId,
      waitedMs: elapsed(),
      canceled: false,
    };
  }
}

/** Token buckets of a batch message in the ledger's spelling, with the per-TTL split. */
export function batchUsageToBuckets(usage: AnthropicBatchUsage | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  totalTokens: number;
} {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(usage?.input_tokens);
  const output = n(usage?.output_tokens);
  const cacheRead = n(usage?.cache_read_input_tokens);
  const cacheWrite = n(usage?.cache_creation_input_tokens);
  const split = usage?.cache_creation;
  const out = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  } as ReturnType<typeof batchUsageToBuckets>;
  if (
    split &&
    (typeof split.ephemeral_5m_input_tokens === "number" ||
      typeof split.ephemeral_1h_input_tokens === "number")
  ) {
    out.cacheWrite5m = n(split.ephemeral_5m_input_tokens);
    out.cacheWrite1h = n(split.ephemeral_1h_input_tokens);
  }
  return out;
}

export function batchStopReason(
  stop: string | null | undefined,
): "stop" | "length" | "toolUse" | "error" {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    default:
      return "stop";
  }
}
