import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchStopReason,
  batchUsageToBuckets,
  findBatchResultLine,
  isBatchTemporarilyUnsupported,
  normalizeBatchBaseUrl,
  resetAnthropicBatchStateForTest,
  runAnthropicBatchCall,
} from "./anthropic-batch.js";

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> };

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(script: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const step = script.shift();
    if (!step) {
      throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    }
    return step(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const request = {
  model: "claude-haiku-4-5",
  max_tokens: 256,
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("runAnthropicBatchCall", () => {
  beforeEach(() => resetAnthropicBatchStateForTest());

  it("submits one request, polls until ended, and returns the message keyed by custom_id", async () => {
    const results =
      `${JSON.stringify({ custom_id: "other", result: { type: "succeeded", message: { content: [{ type: "text", text: "nope" }] } } })}\n` +
      `${JSON.stringify({
        custom_id: "lane-1",
        result: {
          type: "succeeded",
          message: {
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "hello from batch" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
            },
          },
        },
      })}\n`;
    const { fetchImpl, calls } = makeFetch([
      (c) => {
        expect(c.method).toBe("POST");
        expect(c.url).toBe("https://api.anthropic.com/v1/messages/batches");
        expect(c.headers["x-api-key"]).toBe("sk-test");
        expect(c.headers["anthropic-version"]).toBe("2023-06-01");
        expect(
          (c.body as { requests: Array<{ custom_id: string; params: unknown }> }).requests,
        ).toEqual([{ custom_id: "lane-1", params: request }]);
        return json(200, { id: "msgbatch_1", processing_status: "in_progress", results_url: null });
      },
      () => json(200, { id: "msgbatch_1", processing_status: "in_progress" }),
      () => json(503, "busy"),
      () =>
        json(200, {
          id: "msgbatch_1",
          processing_status: "ended",
          results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
          request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
        }),
      (c) => {
        expect(c.url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_1/results");
        return json(200, results);
      },
    ]);
    const sleeps: number[] = [];
    let clock = 0;
    const out = await runAnthropicBatchCall({
      apiKey: "sk-test",
      baseUrl: "https://api.anthropic.com/v1",
      request,
      customId: "lane-1",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      pollInitialMs: 1_000,
      pollMaxMs: 2_000,
      maxWaitMs: 60_000,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.batchId).toBe("msgbatch_1");
    expect(out.polls).toBe(3);
    expect(out.message.content?.[0]?.text).toBe("hello from batch");
    expect(sleeps).toEqual([1_000, 1_600, 2_000]);
    expect(calls).toHaveLength(5);
    expect(batchUsageToBuckets(out.message.usage)).toEqual({
      input: 10,
      output: 4,
      cacheRead: 50,
      cacheWrite: 100,
      cacheWrite5m: 0,
      cacheWrite1h: 100,
      totalTokens: 164,
    });
  });

  it("cancels and reports timeout when the batch does not end in time", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => json(200, { id: "msgbatch_2", processing_status: "in_progress" }),
      () => json(200, { id: "msgbatch_2", processing_status: "in_progress" }),
      () => json(200, { id: "msgbatch_2", processing_status: "in_progress" }),
      (c) => {
        expect(c.method).toBe("POST");
        expect(c.url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_2/cancel");
        return json(200, { id: "msgbatch_2", processing_status: "canceling" });
      },
    ]);
    let clock = 0;
    const out = await runAnthropicBatchCall({
      apiKey: "k",
      request,
      fetchImpl,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      pollInitialMs: 10_000,
      pollMaxMs: 10_000,
      maxWaitMs: 25_000,
    });
    expect(out.ok).toBe(false);
    if (out.ok) {
      return;
    }
    expect(out.reason).toBe("timeout");
    expect(out.canceled).toBe(true);
    expect(out.batchId).toBe("msgbatch_2");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "POST"]);
  });

  it("falls back on submit errors and remembers an unsupported endpoint for a while", async () => {
    const { fetchImpl } = makeFetch([() => json(404, { error: "not found" })]);
    const out = await runAnthropicBatchCall({
      apiKey: "k",
      baseUrl: "https://proxy.example.com",
      request,
      fetchImpl,
      sleep: async () => {},
    });
    expect(out).toMatchObject({ ok: false, reason: "submit-error", canceled: false });
    expect(isBatchTemporarilyUnsupported("https://proxy.example.com/")).toBe(true);
    expect(isBatchTemporarilyUnsupported("https://api.anthropic.com")).toBe(false);
    const again = await runAnthropicBatchCall({
      apiKey: "k",
      baseUrl: "https://proxy.example.com",
      request,
      fetchImpl,
      sleep: async () => {},
    });
    expect(again).toMatchObject({ ok: false, reason: "unsupported" });

    const network = makeFetch([
      () => {
        throw new Error("ECONNRESET");
      },
    ]);
    const failed = await runAnthropicBatchCall({
      apiKey: "k",
      request,
      fetchImpl: network.fetchImpl,
      sleep: async () => {},
    });
    expect(failed).toMatchObject({ ok: false, reason: "submit-error", error: "ECONNRESET" });
  });

  it("reports errored / expired results and a missing custom_id as failures without throwing", async () => {
    const run = (line: string) =>
      runAnthropicBatchCall({
        apiKey: "k",
        request,
        customId: "c",
        fetchImpl: makeFetch([
          () => json(200, { id: "b", processing_status: "in_progress" }),
          () => json(200, { id: "b", processing_status: "ended", results_url: null }),
          () => json(200, line),
        ]).fetchImpl,
        sleep: async () => {},
        pollInitialMs: 1,
      });
    expect(
      await run(
        JSON.stringify({
          custom_id: "c",
          result: {
            type: "errored",
            error: { type: "error", error: { type: "invalid_request_error" } },
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "errored" });
    expect(
      await run(JSON.stringify({ custom_id: "c", result: { type: "expired" } })),
    ).toMatchObject({ ok: false, reason: "expired" });
    expect(
      await run(JSON.stringify({ custom_id: "zzz", result: { type: "succeeded", message: {} } })),
    ).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  it("honors an abort signal by canceling the batch", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = makeFetch([
      () => json(200, { id: "b", processing_status: "in_progress" }),
      () => json(200, { id: "b", processing_status: "canceling" }),
    ]);
    const out = await runAnthropicBatchCall({
      apiKey: "k",
      request,
      fetchImpl,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
      pollInitialMs: 1,
    });
    expect(out).toMatchObject({ ok: false, reason: "aborted", canceled: true });
    expect(calls.at(-1)?.url).toContain("/cancel");
  });

  it("helpers: base url normalization, JSONL lookup, stop reasons", () => {
    expect(normalizeBatchBaseUrl(undefined)).toBe("https://api.anthropic.com");
    expect(normalizeBatchBaseUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com",
    );
    expect(
      findBatchResultLine('garbage\n{"custom_id":"a","result":{"type":"expired"}}\n', "a")?.result
        ?.type,
    ).toBe("expired");
    expect(findBatchResultLine("", "a")).toBeNull();
    expect(batchStopReason("end_turn")).toBe("stop");
    expect(batchStopReason("max_tokens")).toBe("length");
    expect(batchStopReason("tool_use")).toBe("toolUse");
    expect(batchStopReason("refusal")).toBe("error");
  });
});
