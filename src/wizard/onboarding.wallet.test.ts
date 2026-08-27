import { afterEach, describe, expect, it, vi } from "vitest";
import { setupWalletForOnboarding } from "./onboarding.wallet.js";

function prompter(overrides?: Record<string, unknown>) {
  return {
    select: vi.fn(async () => "skip"),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    note: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];

describe("setupWalletForOnboarding (PLAN-41 D-M)", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });
  const clearEnv = () => {
    for (const k of CDP_ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  };

  it("quickstart with zero creds never prompts and never reaches the CDP select", async () => {
    clearEnv();
    const p = prompter();
    const out = await setupWalletForOnboarding({ config: {}, flow: "quickstart", prompter: p });
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

  it("quickstart does NOT write enabled:true (wallet stays opt-in per the D-D flip)", async () => {
    clearEnv();
    const out = await setupWalletForOnboarding({
      config: {},
      flow: "quickstart",
      prompter: prompter(),
    });
    expect(out.tools?.wallet?.enabled).toBeUndefined();
  });

  it("quickstart leaves an existing explicit opt-in untouched", async () => {
    clearEnv();
    const config = { tools: { wallet: { enabled: true, network: "base-sepolia" } } };
    const out = await setupWalletForOnboarding({
      config,
      flow: "quickstart",
      prompter: prompter(),
    });
    expect(out).toBe(config);
  });

  it("advanced declining the enable confirm records enabled:false", async () => {
    clearEnv();
    const p = prompter({ confirm: vi.fn(async () => false) });
    const out = await setupWalletForOnboarding({ config: {}, flow: "advanced", prompter: p });
    expect(out.tools?.wallet?.enabled).toBe(false);
  });

  it("advanced enable confirm defaults to NO on a fresh config", async () => {
    clearEnv();
    const confirm = vi.fn(async () => false);
    const p = prompter({ confirm });
    await setupWalletForOnboarding({ config: {}, flow: "advanced", prompter: p });
    expect(confirm.mock.calls[0]![0].initialValue).toBe(false);
  });
});
