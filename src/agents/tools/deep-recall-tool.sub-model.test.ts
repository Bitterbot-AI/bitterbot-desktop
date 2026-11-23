import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../runtime/models/index.js", () => ({
  discoverAuthStorage: () => ({ list: () => [] }),
}));
vi.mock("../agent-paths.js", () => ({
  resolveBitterbotAgentDir: () => "/tmp/bitterbot-test-agent",
}));

const { resolveSubModel } = await import("./deep-recall-tool.js");

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

it("picks the Google sub-model when only a Google key is set", async () => {
  process.env.GOOGLE_API_KEY = "test-key";
  const sub = await resolveSubModel(undefined, "auto");
  expect(sub?.provider).toBe("google");
  // gemini-2.0-flash-lite was shut down on the Gemini API on 2026-06-01.
  expect(sub?.model).not.toBe("gemini-2.0-flash-lite");
});

it("picks the Anthropic sub-model when only an Anthropic key is set", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  expect((await resolveSubModel(undefined, "auto"))?.provider).toBe("anthropic");
});

it("keeps an explicitly configured sub-model", async () => {
  expect(await resolveSubModel(undefined, "openai/gpt-5-mini")).toEqual({
    provider: "openai",
    model: "gpt-5-mini",
  });
});
