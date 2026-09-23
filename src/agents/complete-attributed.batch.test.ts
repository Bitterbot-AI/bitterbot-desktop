import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelPricingMemoForTest } from "../infra/model-pricing.js";
import {
  UsageLedger,
  flushUsageLedger,
  setUsageLedgerConfigEnabledForTest,
  setUsageLedgerForTest,
} from "../infra/usage-ledger.js";

const completeSimple = vi.fn();
const runAnthropicBatchCall = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...a: unknown[]) => completeSimple(...a),
}));
vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: (provider: string, modelId: string) => ({
    model: {
      id: modelId,
      provider,
      api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
      baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
      headers: undefined,
    },
  }),
}));
vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: async () => ({ apiKey: "sk-test", mode: "api-key", source: "env" }),
  requireApiKey: (auth: { apiKey?: string }) => auth.apiKey,
}));
vi.mock("./pi-embedded-runner/extra-params.js", () => ({ resolveCacheTtlLabel: () => "5m" }));
vi.mock("../infra/anthropic-batch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/anthropic-batch.js")>();
  return { ...actual, runAnthropicBatchCall: (...a: unknown[]) => runAnthropicBatchCall(...a) };
});

import { completeAttributed, resolveBatchLane, toBatchParams } from "./complete-attributed.js";

const liveMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  usage: {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_100_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

describe("completeAttributed batch routing", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
    setUsageLedgerConfigEnabledForTest(true);
    completeSimple.mockReset();
    runAnthropicBatchCall.mockReset();
    completeSimple.mockImplementation(async () => liveMessage("live answer"));
  });
  afterEach(() => {
    setUsageLedgerForTest(null);
    ledger.close();
  });

  it("routes a batch lane through the Batches API and records a batch row at 50%", async () => {
    runAnthropicBatchCall.mockResolvedValue({
      ok: true,
      batchId: "msgbatch_1",
      waitedMs: 4_000,
      polls: 2,
      message: {
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "batched answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      },
    });
    const res = await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "dream about it",
      feature: "memory/dream",
      agentId: "main",
      runId: "run-1",
      maxTokens: 512,
    });
    expect(res.text).toBe("batched answer");
    expect(res.batched).toBe(true);
    expect(completeSimple).not.toHaveBeenCalled();
    const call = runAnthropicBatchCall.mock.calls[0]?.[0] as {
      apiKey: string;
      baseUrl: string;
      maxWaitMs: number;
      request: { model: string; max_tokens: number; messages: unknown[] };
      customId: string;
    };
    expect(call.apiKey).toBe("sk-test");
    expect(call.maxWaitMs).toBe(20 * 60_000);
    expect(call.request).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "dream about it" }],
    });
    expect(call.customId).toBe("memory/dream-run-1");
    await flushUsageLedger();
    const rows = ledger.rows({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "memory/dream",
      batch: true,
      agentId: "main",
      runId: "run-1",
      status: "ok",
    });
    expect(rows[0]!.usage.input).toBe(1_000_000);
    // Same tokens live for comparison: batch row is exactly half.
    const { priceUsage, resolveModelPricing } = await import("../infra/model-pricing.js");
    const table = await resolveModelPricing({ provider: "anthropic", model: "claude-haiku-4-5" });
    const live = priceUsage(table.price, rows[0]!.usage).total;
    expect(rows[0]!.cost.total).toBeCloseTo(live / 2, 6);
  });

  it("falls back to the live call on timeout and on errors, recording a normal row", async () => {
    runAnthropicBatchCall.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      waitedMs: 1_200_000,
      canceled: true,
      batchId: "b",
    });
    const res = await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "extract",
      feature: "memory/extraction",
    });
    expect(res.text).toBe("live answer");
    expect(res.batched).toBeUndefined();
    expect(completeSimple).toHaveBeenCalledTimes(1);

    runAnthropicBatchCall.mockResolvedValueOnce({
      ok: false,
      reason: "submit-error",
      error: "HTTP 500",
      waitedMs: 10,
      canceled: false,
    });
    await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "x",
      feature: "memory/discovery",
    });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    await flushUsageLedger();
    const rows = ledger.rows({});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.batch)).toBe(true);
  });

  it("attributes background calls served by OpenRouter to the Bitterbot app", async () => {
    await completeAttributed({
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      prompt: "extract",
      feature: "memory/extraction",
    });
    await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "judge",
      feature: "tasks/judge",
    });
    const orOptions = completeSimple.mock.calls[0]?.[2] as { headers?: Record<string, string> };
    expect(orOptions.headers).toMatchObject({
      "HTTP-Referer": "https://bitterbot.ai",
      "X-OpenRouter-Title": "Bitterbot",
    });
    const anthropicOptions = completeSimple.mock.calls[1]?.[2] as { headers?: unknown };
    expect(anthropicOptions.headers).toBeUndefined();
  });

  it("never batches non-lane features, non-anthropic providers, or when disabled by config", async () => {
    await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "judge",
      feature: "tasks/judge",
    });
    await completeAttributed({
      provider: "openai",
      modelId: "gpt-4o-mini",
      prompt: "dream",
      feature: "memory/dream",
    });
    await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "dream",
      feature: "memory/dream",
      cfg: { memory: { batch: { enabled: false } } } as never,
    });
    await completeAttributed({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "dream",
      feature: "memory/dream",
      batch: false,
    });
    expect(runAnthropicBatchCall).not.toHaveBeenCalled();
    expect(completeSimple).toHaveBeenCalledTimes(4);
  });

  it("lane decision and message conversion helpers", () => {
    expect(resolveBatchLane(undefined, "memory/dream")).toEqual({
      batch: true,
      maxWaitMinutes: 20,
    });
    expect(resolveBatchLane(undefined, "skills/evolution").batch).toBe(true);
    expect(resolveBatchLane(undefined, "tasks/judge").batch).toBe(false);
    expect(resolveBatchLane(undefined, "agent/turn").batch).toBe(false);
    expect(
      resolveBatchLane(
        { memory: { batch: { lanes: ["tasks/judge"], maxWaitMinutes: 5 } } } as never,
        "tasks/judge",
      ),
    ).toEqual({
      batch: true,
      maxWaitMinutes: 5,
    });
    expect(
      resolveBatchLane({ memory: { batch: { lanes: ["tasks/judge"] } } } as never, "memory/dream")
        .batch,
    ).toBe(false);
    expect(
      toBatchParams(
        [
          {
            role: "user",
            content: [{ type: "image", data: "", mimeType: "image/png" }],
            timestamp: 0,
          },
        ] as never,
        "m",
        1,
      ),
    ).toBeNull();
    expect(toBatchParams([{ role: "toolResult" }] as never, "m", 1)).toBeNull();
    expect(
      toBatchParams(
        [
          { role: "user", content: [{ type: "text", text: "a" }], timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 0 },
        ] as never,
        "m",
        7,
      ),
    ).toEqual({
      model: "m",
      max_tokens: 7,
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
      ],
    });
  });
});
