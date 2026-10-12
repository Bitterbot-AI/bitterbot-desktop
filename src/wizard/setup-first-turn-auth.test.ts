/**
 * PLAN-56 Phase 4 review (item 18): the first reply runs between setup's two
 * config writes, so `auth.*` (restart-sensitive) is NOT in the config the
 * gateway has when it runs. This proves the credential setup chose still
 * resolves from the auth store through the same calls the embedded runner
 * makes (src/agents/embedded-runner/run.ts: resolveAuthProfileOrder, then
 * getApiKeyForModel), with no provider network call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import type { BitterbotConfig } from "../config/config.js";
import { storeProviderKey } from "./setup-keys.js";
import { commitSetupKey, createSetupDraft, type SetupContext } from "./setup-steps.js";
import { splitRestartSensitive } from "./setup-wizard.js";

const KEY = "sk-ant-api03-first-turn-key-9f2c";
let dir: string;
let agentDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-first-turn-auth-"));
  agentDir = path.join(dir, "agent");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const model = {
  id: "claude-opus-4-8",
  provider: "anthropic",
  api: "anthropic-messages",
} as Model<Api>;

/** What the runner does with the config the gateway has during the first reply. */
async function resolveLikeTheRunner(cfg: BitterbotConfig) {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const order = resolveAuthProfileOrder({ cfg, store, provider: "anthropic" });
  const auth = await getApiKeyForModel({ model, cfg, profileId: order[0], store, agentDir });
  return { order, auth };
}

describe("first reply with auth.* deferred to Finish", () => {
  it("a stored API key resolves although the hot config has no auth section", async () => {
    const full = await storeProviderKey({
      provider: "anthropic",
      key: KEY,
      source: "pasted",
      config: {},
      agentDir,
    });
    expect(full.auth?.profiles?.["anthropic:default"]).toBeDefined();
    const { hot, deferredKeys } = await splitRestartSensitive({}, full);
    expect(deferredKeys).toContain("auth");
    expect(hot.auth).toBeUndefined();

    const { order, auth } = await resolveLikeTheRunner(hot);
    expect(order).toEqual(["anthropic:default"]);
    expect(auth.apiKey).toBe(KEY);
    expect(auth.profileId).toBe("anthropic:default");
  });

  it("a saved token sign-in chosen in setup resolves the same way", async () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:claude-cli": {
            type: "token",
            provider: "anthropic",
            token: "sk-ant-oat01-saved-token-value",
          },
        },
      }),
    );
    const draft = createSetupDraft({});
    draft.authProfile = { profileId: "anthropic:claude-cli", provider: "anthropic", mode: "token" };
    const ctx: SetupContext = {
      effective: {},
      keys: [],
      keyEnv: { env: {}, agentDir },
      installKind: "package",
    };
    await commitSetupKey(draft, ctx);
    const { hot } = await splitRestartSensitive({}, draft.config);
    expect(hot.auth).toBeUndefined();

    const { order, auth } = await resolveLikeTheRunner(hot);
    expect(order).toEqual(["anthropic:claude-cli"]);
    expect(auth.apiKey).toBe("sk-ant-oat01-saved-token-value");
    expect(auth.mode).toBe("token");
  });
});
