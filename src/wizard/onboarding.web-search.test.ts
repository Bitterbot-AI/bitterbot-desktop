import { afterEach, describe, expect, it, vi } from "vitest";
import { setupWebSearchForOnboarding } from "./onboarding.web-search.js";

function prompter(selectValue = "tavily", textValue = "") {
  return {
    select: vi.fn(async () => selectValue),
    text: vi.fn(async () => textValue),
    confirm: vi.fn(async () => true),
    note: vi.fn(async () => {}),
  } as never;
}

const ENV_KEYS = ["BRAVE_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY"];

describe("setupWebSearchForOnboarding (PLAN-41 D-M)", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });
  const clearEnv = () => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  };

  it("quickstart with no key asks nothing and leaves the config untouched", async () => {
    clearEnv();
    const p = prompter();
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "quickstart", prompter: p });
    expect(out).toEqual({});
    const mocks = p as {
      select: ReturnType<typeof vi.fn>;
      confirm: ReturnType<typeof vi.fn>;
      text: ReturnType<typeof vi.fn>;
    };
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
  });

  it("quickstart with an env key still detects it without prompting", async () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-test";
    const p = prompter();
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "quickstart", prompter: p });
    expect(out).toEqual({});
    expect((p as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it("advanced still walks provider + key", async () => {
    clearEnv();
    const p = prompter("tavily", "tvly-abc");
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "advanced", prompter: p });
    expect(out.tools?.web?.search?.provider).toBe("tavily");
    const tavily = (out.tools?.web?.search as Record<string, { apiKey?: string }> | undefined)
      ?.tavily;
    expect(tavily?.apiKey).toBe("tvly-abc");
  });
});
