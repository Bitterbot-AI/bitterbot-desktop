import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";

// Hoisted mock state — the dynamic-import inside createJudgeLlmCall picks these up.
const completeSimpleMock = vi.fn();
const resolveModelMock = vi.fn();
const getApiKeyForModelMock = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModelMock(...args),
}));

import { createJudgeLlmCall, registerJudgeFromConfig } from "./judge-provider.js";
import { getJudgeLlmCall, registerJudgeLlmCall } from "./judge.js";

const fakeModel = { id: "claude-opus-4-7", provider: "anthropic" };

function withConfig(primary?: string): BitterbotConfig {
  const base = primary
    ? { agents: { defaults: { model: { primary } } } }
    : { agents: { defaults: {} } };
  return base as unknown as BitterbotConfig;
}

describe("createJudgeLlmCall", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resolveModelMock.mockReset();
    getApiKeyForModelMock.mockReset();
    resolveModelMock.mockReturnValue({ model: fakeModel });
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-test", mode: "api-key" });
  });

  afterEach(() => {
    delete process.env.BITTERBOT_TASKS_JUDGE_MODEL;
  });

  it("returns the model's text content on a happy-path call", async () => {
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "```yaml\nverdict: pass\nreasoning: ok\n```" }],
    });
    const llm = createJudgeLlmCall(withConfig());
    const out = await llm("hello judge");
    expect(out).toContain("verdict: pass");
    expect(completeSimpleMock).toHaveBeenCalledOnce();

    const [model, request, options] = completeSimpleMock.mock.calls[0];
    expect(model).toBe(fakeModel);
    expect((request as { messages: Array<{ role: string }> }).messages[0].role).toBe("user");
    expect((options as { temperature: number }).temperature).toBe(0);
    expect((options as { maxTokens: number }).maxTokens).toBe(600);
    expect((options as { apiKey: string }).apiKey).toBe("sk-test");
  });

  it("uses BITTERBOT_TASKS_JUDGE_MODEL when set", async () => {
    process.env.BITTERBOT_TASKS_JUDGE_MODEL = "anthropic/claude-opus-4-7-test";
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const llm = createJudgeLlmCall(withConfig());
    await llm("p");
    expect(resolveModelMock).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-7-test",
      undefined,
      expect.any(Object),
    );
  });

  it("falls back to anthropic/claude-opus-4-7 when neither override nor config primary is set", async () => {
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const llm = createJudgeLlmCall(undefined);
    await llm("p");
    expect(resolveModelMock).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-7",
      undefined,
      undefined,
    );
  });

  it("prefers config primary over the hardcoded default", async () => {
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const llm = createJudgeLlmCall(withConfig("opencode/claude-opus-4-6"));
    await llm("p");
    expect(resolveModelMock).toHaveBeenCalledWith(
      "opencode",
      "claude-opus-4-6",
      undefined,
      expect.any(Object),
    );
  });

  it("retries with backoff on rate-limit errors and eventually succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    completeSimpleMock
      .mockRejectedValueOnce(new Error("HTTP 429 rate limit"))
      .mockRejectedValueOnce(new Error("rate limit again"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const llm = createJudgeLlmCall(withConfig(), { sleep });
    const out = await llm("p");
    expect(out).toBe("ok");
    expect(completeSimpleMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(1_000);
    expect(sleep.mock.calls[1][0]).toBe(2_000);
  });

  it("retries on 5xx and surfaces the last error when all attempts fail", async () => {
    const sleep = vi.fn(async () => undefined);
    completeSimpleMock.mockRejectedValue(new Error("HTTP 503 service unavailable"));
    const llm = createJudgeLlmCall(withConfig(), { sleep, attempts: 3 });
    await expect(llm("p")).rejects.toThrow(/503/);
    expect(completeSimpleMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors (auth, 4xx other than 429)", async () => {
    const sleep = vi.fn(async () => undefined);
    completeSimpleMock.mockRejectedValueOnce(new Error("HTTP 401 unauthorized"));
    const llm = createJudgeLlmCall(withConfig(), { sleep });
    await expect(llm("p")).rejects.toThrow(/401/);
    expect(completeSimpleMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws when resolveModel returns no model", async () => {
    resolveModelMock.mockReturnValue({ error: "no such model" });
    const llm = createJudgeLlmCall(withConfig());
    await expect(llm("p")).rejects.toThrow(/cannot resolve model/);
  });

  it("throws when the model returns empty content", async () => {
    completeSimpleMock.mockResolvedValueOnce({ content: [] });
    const llm = createJudgeLlmCall(withConfig());
    await expect(llm("p")).rejects.toThrow(/no text content/);
  });
});

describe("registerJudgeFromConfig", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resolveModelMock.mockReset();
    getApiKeyForModelMock.mockReset();
    resolveModelMock.mockReturnValue({ model: fakeModel });
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-test", mode: "api-key" });
    registerJudgeLlmCall(null);
  });

  afterEach(() => {
    registerJudgeLlmCall(null);
  });

  it("registers a working judge call when config has a primary model", () => {
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const ok = registerJudgeFromConfig(withConfig("anthropic/claude-opus-4-7"));
    expect(ok).toBe(true);
    expect(getJudgeLlmCall()).toBeTypeOf("function");
  });

  it("the registered call delegates to the underlying completion", async () => {
    completeSimpleMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "verdict: pass" }],
    });
    registerJudgeFromConfig(withConfig());
    const llm = getJudgeLlmCall()!;
    const out = await llm("hi");
    expect(out).toBe("verdict: pass");
  });
});
