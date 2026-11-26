import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ providers: [] as string[] }));

vi.mock("../runtime/models/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/models/index.js")>()),
  discoverAuthStorage: () => ({ list: () => stored.providers }),
}));
vi.mock("../agent-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-paths.js")>()),
  resolveBitterbotAgentDir: () => "/tmp/bitterbot-test-agent",
}));

const { resolveSubModel } = await import("./deep-recall-tool.js");

const KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  stored.providers = [];
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

it("picks the Google sub-model when only the Gemini key is set", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const sub = await resolveSubModel(undefined, "auto");
  expect(sub?.provider).toBe("google");
  // gemini-2.0-flash-lite was shut down on the Gemini API on 2026-06-01.
  expect(sub?.model).not.toBe("gemini-2.0-flash-lite");
});

it("does not pick Google on GOOGLE_API_KEY, which model auth does not read for it", async () => {
  process.env.GOOGLE_API_KEY = "test-key";
  expect(await resolveSubModel(undefined, "auto")).toBeNull();
});

it("picks the Anthropic sub-model when only an Anthropic key is set", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  expect((await resolveSubModel(undefined, "auto"))?.provider).toBe("anthropic");
});

it("picks a provider that only has stored credentials", async () => {
  stored.providers = ["google"];
  expect((await resolveSubModel(undefined, "auto"))?.provider).toBe("google");
});

it("prefers OpenAI when several providers have keys", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  expect((await resolveSubModel(undefined, "auto"))?.provider).toBe("openai");
});

it("returns null when no provider has credentials", async () => {
  expect(await resolveSubModel(undefined, "auto")).toBeNull();
});

it("keeps an explicitly configured sub-model", async () => {
  expect(await resolveSubModel(undefined, "openai/gpt-5-mini")).toEqual({
    provider: "openai",
    model: "gpt-5-mini",
  });
});
