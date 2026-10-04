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

const ENV_KEYS = [
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "XAI_API_KEY",
  "SERPLY_API_KEY",
];

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

  it("quickstart with an env key stores the detected provider without prompting", async () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-test";
    const p = prompter();
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "quickstart", prompter: p });
    expect(out).toEqual({ tools: { web: { search: { provider: "tavily" } } } });
    expect((p as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it("an incumbent env key wins over SERPLY_API_KEY", async () => {
    clearEnv();
    process.env.BRAVE_API_KEY = "test-existing";
    process.env.SERPLY_API_KEY = "serply-test";
    const p = prompter();
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "quickstart", prompter: p });
    expect(out.tools?.web?.search?.provider).toBe("brave");
  });

  it("selects Serply from the environment only when it is the sole search key", async () => {
    clearEnv();
    process.env.SERPLY_API_KEY = "serply-test";
    const p = prompter();
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "advanced", prompter: p });
    expect(out.tools?.web?.search?.provider).toBe("serply");
    expect((p as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it("does not count another provider's env key for an explicit selection", async () => {
    clearEnv();
    process.env.BRAVE_API_KEY = "test-existing";
    const config = { tools: { web: { search: { provider: "tavily" as const } } } };
    const p = prompter("serply", "serply-abc");
    const out = await setupWebSearchForOnboarding({ config, flow: "advanced", prompter: p });
    expect((p as { select: ReturnType<typeof vi.fn> }).select).toHaveBeenCalled();
    expect(out.tools?.web?.search?.provider).toBe("serply");
    const serply = (out.tools?.web?.search as Record<string, { apiKey?: string }> | undefined)
      ?.serply;
    expect(serply?.apiKey).toBe("serply-abc");
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
  it("advanced Parallel selection enables keyless search without a key prompt", async () => {
    clearEnv();
    const p = prompter("parallel");
    const out = await setupWebSearchForOnboarding({ config: {}, flow: "advanced", prompter: p });
    expect(out.tools?.web?.search).toEqual({ provider: "parallel", enabled: true });
    expect((p as { text: ReturnType<typeof vi.fn> }).text).not.toHaveBeenCalled();
  });
  it("preserves a saved Parallel selection even when incumbent keys are present", async () => {
    clearEnv();
    process.env.BRAVE_API_KEY = "test-existing";
    const config = {
      tools: { web: { search: { provider: "parallel" as const, enabled: false } } },
    };
    const p = prompter();
    expect(await setupWebSearchForOnboarding({ config, flow: "quickstart", prompter: p })).toEqual(
      config,
    );
    expect((p as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});
