import { afterEach, describe, expect, it, vi } from "vitest";
import { setupEmbeddingsForOnboarding } from "./onboarding.embeddings.js";

vi.mock("../memory/sqlite-vec.js", () => ({
  probeSqliteVec: vi.fn(async () => ({ ok: true })),
}));

function prompter(selectValue: string, textValue = "") {
  return {
    select: vi.fn(async () => selectValue),
    text: vi.fn(async () => textValue),
    confirm: vi.fn(async () => true),
    note: vi.fn(async () => {}),
  } as never;
}

const ENV_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "VOYAGE_API_KEY"];

describe("setupEmbeddingsForOnboarding (PLAN-41 D-F)", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });
  const clearEnv = () => {
    for (const k of [...ENV_KEYS, "ANTHROPIC_API_KEY"]) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  };

  it('offers "Local (no API key)" and pins provider local when chosen', async () => {
    clearEnv();
    const p = prompter("local");
    const out = await setupEmbeddingsForOnboarding({
      config: {},
      flow: "quickstart",
      prompter: p,
    });
    expect(out.agents?.defaults?.memorySearch?.provider).toBe("local");
    const options = (p as { select: ReturnType<typeof vi.fn> }).select.mock.calls[0]![0].options;
    expect(options[0].value).toBe("local");
  });

  it("defaults the selection to local for Anthropic-only installs", async () => {
    clearEnv();
    saved.set("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const p = prompter("local");
    await setupEmbeddingsForOnboarding({ config: {}, flow: "quickstart", prompter: p });
    const call = (p as { select: ReturnType<typeof vi.fn> }).select.mock.calls[0]![0];
    expect(call.initialValue).toBe("local");
  });

  it("does NOT pin a remote provider when the key is left blank", async () => {
    clearEnv();
    const p = prompter("openai", "");
    const out = await setupEmbeddingsForOnboarding({
      config: {},
      flow: "quickstart",
      prompter: p,
    });
    expect(out.agents?.defaults?.memorySearch?.provider).toBeUndefined();
  });

  it("pins provider + key when a key is entered", async () => {
    clearEnv();
    const p = prompter("openai", "sk-test-123");
    const out = await setupEmbeddingsForOnboarding({
      config: {},
      flow: "quickstart",
      prompter: p,
    });
    expect(out.agents?.defaults?.memorySearch?.provider).toBe("openai");
    expect(out.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("sk-test-123");
  });
});
