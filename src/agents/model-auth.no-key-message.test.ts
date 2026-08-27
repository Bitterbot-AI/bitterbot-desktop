import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

// zai has exactly two env fallbacks and no config/custom paths, which makes
// it the cheapest provider to drive into the "nothing found" throw.
const ENV_KEYS = ["ZAI_API_KEY", "Z_AI_API_KEY"];

describe("no-key error message (PLAN-41 no-key-error)", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  async function messageFor(store: AuthProfileStore): Promise<string> {
    try {
      await resolveApiKeyForProvider({ provider: "zai", store });
    } catch (err) {
      return String(err);
    }
    throw new Error("expected resolveApiKeyForProvider to throw");
  }

  it("zero profiles = fresh install: points at onboard / Models & Keys, keeps the machine prefix", async () => {
    const msg = await messageFor({ version: 1, profiles: {} });
    expect(msg).toContain('No API key found for provider "zai".');
    expect(msg).toContain("onboard");
    expect(msg).toContain("Models & Keys");
    expect(msg).not.toContain("auth-profiles.json");
  });

  it("existing profiles for another provider: keeps the per-agent auth-store guidance", async () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-x" },
      },
    } as unknown as AuthProfileStore;
    const msg = await messageFor(store);
    expect(msg).toContain('No API key found for provider "zai".');
    expect(msg).toContain("auth-profiles.json");
  });
});
