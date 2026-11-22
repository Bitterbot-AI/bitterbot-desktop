import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...a: unknown[]) => completeSimple(...a),
}));
vi.mock("./embedded-runner/model.js", () => ({
  resolveModel: (provider: string, modelId: string) => ({
    model: {
      id: modelId,
      provider,
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      headers: undefined,
    },
  }),
}));
vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: async () => ({ apiKey: "sk-test", mode: "api-key", source: "env" }),
  requireApiKey: (auth: { apiKey?: string }) => auth.apiKey,
}));
vi.mock("./embedded-runner/extra-params.js", () => ({ resolveCacheTtlLabel: () => "5m" }));

import {
  completeAttributed,
  isThinkingDisabledRejection,
  resetThinkingOffCacheForTest,
  rewriteThinkingOff,
} from "./complete-attributed.js";

const REJECTION =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"To turn thinking off on this model, send \\"thinking\\": {\\"type\\": \\"between_tools\\"} instead of {\\"type\\": \\"disabled\\"}."}}';

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const ok = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-test",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});
const rejected = () => ({ ...ok(""), content: [], stopReason: "error", errorMessage: REJECTION });

type Options = { onPayload: (payload: unknown) => unknown };
const sentThinking = (callIndex: number): unknown => {
  const options = completeSimple.mock.calls[callIndex]![2] as Options;
  const payload = { model: "claude-test", thinking: { type: "disabled" } };
  const next = (options.onPayload(payload) ?? payload) as { thinking: unknown };
  return next.thinking;
};

const run = (modelId = "claude-test") =>
  completeAttributed({
    provider: "anthropic",
    modelId,
    prompt: "hi",
    feature: "rlm/deep-recall",
    ignoreBudget: true,
    batch: false,
  });

describe("completeAttributed thinking-off handling", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    resetThinkingOffCacheForTest();
  });

  it("leaves the payload alone when the model accepts disabled", async () => {
    completeSimple.mockResolvedValueOnce(ok("fine"));
    const result = await run();
    expect(result.text).toBe("fine");
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(sentThinking(0)).toEqual({ type: "disabled" });
  });

  it("retries once with between_tools when the provider rejects disabled", async () => {
    completeSimple.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok("recovered"));
    const result = await run();
    expect(result.text).toBe("recovered");
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(sentThinking(0)).toEqual({ type: "disabled" });
    expect(sentThinking(1)).toEqual({ type: "between_tools" });
  });

  it("remembers the model so later calls skip the rejected request", async () => {
    completeSimple.mockResolvedValueOnce(rejected()).mockResolvedValue(ok("again"));
    await run();
    completeSimple.mockClear();
    await run();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(sentThinking(0)).toEqual({ type: "between_tools" });
  });

  it("keeps the memory per model", async () => {
    completeSimple.mockResolvedValueOnce(rejected()).mockResolvedValue(ok("x"));
    await run("claude-a");
    completeSimple.mockClear();
    await run("claude-b");
    expect(sentThinking(0)).toEqual({ type: "disabled" });
  });

  it("does not retry on unrelated errors", async () => {
    completeSimple.mockResolvedValueOnce({
      ...rejected(),
      errorMessage: "529 overloaded",
    });
    await expect(run()).rejects.toThrow();
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("rewrites only a disabled thinking field", () => {
    expect(rewriteThinkingOff({ thinking: { type: "adaptive" } }, "between_tools")).toBeUndefined();
    expect(rewriteThinkingOff({ model: "m" }, "between_tools")).toBeUndefined();
    expect(rewriteThinkingOff({ thinking: { type: "disabled" } }, "disabled")).toBeUndefined();
    expect(rewriteThinkingOff({ a: 1, thinking: { type: "disabled" } }, "between_tools")).toEqual({
      a: 1,
      thinking: { type: "between_tools" },
    });
  });

  it("recognises only the specific rejection", () => {
    expect(isThinkingDisabledRejection(rejected())).toBe(true);
    expect(isThinkingDisabledRejection(ok("between_tools disabled"))).toBe(false);
    expect(isThinkingDisabledRejection(null)).toBe(false);
  });
});
