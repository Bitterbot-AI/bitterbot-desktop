import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { probeProviderKey } from "../../agents/auth-probe.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store.js";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../../agents/model-auth.js";
import { refreshGatewayModelCatalog } from "../server-model-catalog.js";
import { modelsAuthHandlers } from "./models-auth.js";
import { modelsHandlers } from "./models.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    models: {
      providers: { "custom-local": { baseUrl: "http://127.0.0.1:1/v1", apiKey: "cfg-key" } },
    },
  }),
}));
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
}));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));
vi.mock("../../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveEnvApiKey: vi.fn(),
}));
vi.mock("../../agents/auth-probe.js", () => ({
  probeProviderKey: vi.fn(),
}));
vi.mock("../server-model-catalog.js", () => ({
  refreshGatewayModelCatalog: vi.fn(async () => []),
}));

const SECRET = "sk-test-super-secret-value";

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: SECRET },
    },
    usageStats: {
      "anthropic:default": { cooldownUntil: Date.now() + 60_000, errorCount: 3 },
    },
    order: { anthropic: ["anthropic:default"] },
    lastGood: { anthropic: "anthropic:default" },
  };
}

const context = {
  loadGatewayModelCatalog: vi.fn(async () => [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
    { id: "gpt-5.3", name: "GPT-5.3", provider: "openai" },
  ]),
} as never;

beforeEach(() => {
  vi.mocked(ensureAuthProfileStore).mockReset().mockReturnValue(makeStore());
  vi.mocked(resolveAuthProfileOrder)
    .mockReset()
    .mockImplementation(({ provider }: { provider: string }) =>
      provider === "anthropic" ? ["anthropic:default"] : [],
    );
  vi.mocked(resolveEnvApiKey)
    .mockReset()
    .mockImplementation((provider: string) =>
      provider === "openai" ? { apiKey: SECRET, source: "env: OPENAI_API_KEY" } : null,
    );
  vi.mocked(resolveApiKeyForProvider).mockReset();
  vi.mocked(probeProviderKey).mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(updateAuthProfileStoreWithLock).mockReset();
  vi.mocked(refreshGatewayModelCatalog).mockClear();
});

describe("models.auth.list", () => {
  it("summarizes provider status with winning source and never leaks secrets", async () => {
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.list"]!({
      params: {},
      respond,
      context,
    } as never);

    expect(calls[0].ok).toBe(true);
    const payload = calls[0].payload as {
      providers: Array<{
        provider: string;
        winningSource: string | null;
        envPresent: boolean;
        profiles: Array<{ profileId: string; inCooldown: boolean }>;
        configKeyPresent: boolean;
      }>;
    };
    const anthropic = payload.providers.find((p) => p.provider === "anthropic")!;
    expect(anthropic.winningSource).toBe("profile:anthropic:default");
    expect(anthropic.profiles[0].inCooldown).toBe(true);

    const openai = payload.providers.find((p) => p.provider === "openai")!;
    expect(openai.envPresent).toBe(true);
    expect(openai.winningSource).toBe("env: OPENAI_API_KEY");

    const custom = payload.providers.find((p) => p.provider === "custom-local")!;
    expect(custom.configKeyPresent).toBe(true);
    expect(custom.winningSource).toBe("models.json");

    // Write-only contract: no stored secret may appear anywhere in the payload.
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain("cfg-key");
  });
});

describe("models.auth.test", () => {
  it("probes a draft key without saving", async () => {
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.test"]!({
      params: { provider: "anthropic", apiKey: `  ${SECRET}  ` },
      respond,
      context,
    } as never);

    expect(vi.mocked(probeProviderKey)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", apiKey: SECRET }),
    );
    expect(vi.mocked(updateAuthProfileStoreWithLock)).not.toHaveBeenCalled();
    expect(calls[0].ok).toBe(true);
    expect((calls[0].payload as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it("reports oauth credentials as unsupported instead of probing", async () => {
    vi.mocked(resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "oauth-derived",
      source: "profile:anthropic:oauth",
      mode: "oauth",
    });
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.test"]!({
      params: { provider: "anthropic" },
      respond,
      context,
    } as never);

    expect(vi.mocked(probeProviderKey)).not.toHaveBeenCalled();
    const payload = calls[0].payload as { result: { ok: boolean; unsupported?: boolean } };
    expect(payload.result.ok).toBe(false);
    expect(payload.result.unsupported).toBe(true);
  });

  it("turns a missing-credential throw into a probe failure, not an RPC error", async () => {
    vi.mocked(resolveApiKeyForProvider).mockRejectedValue(
      new Error('No API key found for provider "openai".'),
    );
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.test"]!({
      params: { provider: "openai" },
      respond,
      context,
    } as never);
    expect(calls[0].ok).toBe(true);
    const payload = calls[0].payload as { result: { ok: boolean; error?: string } };
    expect(payload.result.ok).toBe(false);
    expect(payload.result.error).toContain("No API key found");
  });
});

describe("models.auth.set", () => {
  it("writes a normalized api_key credential, clears cooldown state, busts the catalog", async () => {
    const store = makeStore();
    vi.mocked(updateAuthProfileStoreWithLock).mockImplementation(async ({ updater }) => {
      updater(store);
      return store;
    });

    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.set"]!({
      params: { provider: "Anthropic", value: `  ${SECRET}\n` },
      respond,
      context,
    } as never);

    expect(calls[0].ok).toBe(true);
    expect((calls[0].payload as { profileId: string }).profileId).toBe("anthropic:default");
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      key: SECRET,
    });
    // PLAN-37 H2: rotation must not inherit the dead key's cooldown.
    expect(store.usageStats?.["anthropic:default"]).toBeUndefined();
    expect(vi.mocked(refreshGatewayModelCatalog)).toHaveBeenCalled();
    // The response never echoes the secret.
    expect(JSON.stringify(calls[0].payload)).not.toContain(SECRET);
  });

  it("writes token credentials under a named profile", async () => {
    const store = makeStore();
    vi.mocked(updateAuthProfileStoreWithLock).mockImplementation(async ({ updater }) => {
      updater(store);
      return store;
    });
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.set"]!({
      params: {
        provider: "github-copilot",
        name: "Work Laptop",
        credentialType: "token",
        value: SECRET,
      },
      respond,
      context,
    } as never);
    expect(calls[0].ok).toBe(true);
    expect((calls[0].payload as { profileId: string }).profileId).toBe(
      "github-copilot:work-laptop",
    );
    expect(store.profiles["github-copilot:work-laptop"]).toEqual({
      type: "token",
      provider: "github-copilot",
      token: SECRET,
    });
  });

  it("rejects empty credentials", async () => {
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.set"]!({
      params: { provider: "anthropic", value: "   " },
      respond,
      context,
    } as never);
    expect(calls[0].ok).toBe(false);
    expect(vi.mocked(updateAuthProfileStoreWithLock)).not.toHaveBeenCalled();
  });
});

describe("models.auth.delete", () => {
  it("removes the profile plus its stats, order entries, and lastGood pointer", async () => {
    const store = makeStore();
    vi.mocked(updateAuthProfileStoreWithLock).mockImplementation(async ({ updater }) => {
      updater(store);
      return store;
    });
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.delete"]!({
      params: { profileId: "anthropic:default" },
      respond,
      context,
    } as never);
    expect(calls[0].ok).toBe(true);
    expect(store.profiles["anthropic:default"]).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]).toBeUndefined();
    expect(store.order).toBeUndefined();
    expect(store.lastGood?.anthropic).toBeUndefined();
  });

  it("errors on unknown profile ids", async () => {
    const store = makeStore();
    vi.mocked(updateAuthProfileStoreWithLock).mockImplementation(async ({ updater }) => {
      updater(store);
      return store;
    });
    const { calls, respond } = capture();
    await modelsAuthHandlers["models.auth.delete"]!({
      params: { profileId: "nope:missing" },
      respond,
      context,
    } as never);
    expect(calls[0].ok).toBe(false);
  });
});

describe("models.list refresh", () => {
  it("busts the catalog cache when refresh:true", async () => {
    const { calls, respond } = capture();
    await modelsHandlers["models.list"]!({
      params: { refresh: true },
      respond,
      context,
    } as never);
    expect(vi.mocked(refreshGatewayModelCatalog)).toHaveBeenCalled();
    expect(calls[0].ok).toBe(true);
  });

  it("uses the cached catalog path by default", async () => {
    const { calls, respond } = capture();
    await modelsHandlers["models.list"]!({
      params: {},
      respond,
      context,
    } as never);
    expect(vi.mocked(refreshGatewayModelCatalog)).not.toHaveBeenCalled();
    expect(calls[0].ok).toBe(true);
  });
});
