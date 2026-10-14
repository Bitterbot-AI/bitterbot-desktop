import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFeatured } from "../agents/model-featured.js";
import {
  detectSetupKeys,
  detectSignedInProfiles,
  maskKeySuffix,
  resolveDetectedKey,
  SETUP_PROVIDER_ORDER,
  SETUP_PROVIDERS,
  storeProviderKey,
  validatePastedKey,
} from "./setup-keys.js";

const ANTHROPIC = "sk-ant-api03-SECRET-anthropic-value-9f2c";
const OPENAI = "sk-proj-SECRET-openai-value-77ab";
const OPENROUTER = "sk-or-v1-SECRET-openrouter-1234";
const GEMINI = "AIza-FAKE-SECRET-gemini-value-5e6f";

let dir: string;
let agentDir: string;
let envFilePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-setup-keys-"));
  agentDir = path.join(dir, "agent");
  envFilePath = path.join(dir, ".env");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("maskKeySuffix", () => {
  it("shows the last four characters only, and nothing for short values", () => {
    expect(maskKeySuffix(ANTHROPIC)).toBe("...9f2c");
    expect(maskKeySuffix("  sk-1234567890ab  ")).toBe("...90ab");
    expect(maskKeySuffix("short")).toBe("...");
  });
});

describe("setup's model lists", () => {
  it("offer only featured models of the Control UI picker", () => {
    for (const provider of SETUP_PROVIDER_ORDER) {
      for (const model of SETUP_PROVIDERS[provider].models) {
        const slash = model.id.indexOf("/");
        expect(slash, model.id).toBeGreaterThan(0);
        const modelProvider = model.id.slice(0, slash);
        const id = model.id.slice(slash + 1);
        expect(modelProvider, model.id).toBe(provider);
        if (model.id === "openrouter/auto") {
          // OpenRouter's router, not a catalog model: nothing to feature.
          continue;
        }
        expect(classifyFeatured(modelProvider, id).featured, model.id).toBe(true);
      }
    }
  });

  it("recommend the picker's default Anthropic model", () => {
    const recommended = SETUP_PROVIDERS.anthropic.models[0]?.id ?? "";
    expect(classifyFeatured("anthropic", recommended.slice("anthropic/".length))).toMatchObject({
      featured: true,
      isDefault: true,
    });
  });

  it("list Google Gemini after OpenRouter", () => {
    expect(SETUP_PROVIDER_ORDER).toEqual(["anthropic", "openai", "openrouter", "google"]);
    expect(SETUP_PROVIDERS.google.envVar).toBe("GEMINI_API_KEY");
  });
});

describe("detectSetupKeys", () => {
  it("offers keys by name and masked suffix, never the value", () => {
    fs.writeFileSync(envFilePath, `OPENAI_API_KEY=${OPENAI}\n`);
    const keys = detectSetupKeys({
      env: { ANTHROPIC_API_KEY: ANTHROPIC, OPENROUTER_API_KEY: OPENROUTER },
      envFilePath,
      agentDir,
    });
    expect(keys.map((k) => [k.id, k.source, k.masked])).toEqual([
      ["env:ANTHROPIC_API_KEY", "environment", "...9f2c"],
      ["file:OPENAI_API_KEY", "env-file", "...77ab"],
      ["env:OPENROUTER_API_KEY", "environment", "...1234"],
    ]);
    const serialized = JSON.stringify(keys);
    for (const secret of [ANTHROPIC, OPENAI, OPENROUTER, "SECRET"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("finds a Gemini key in the environment, ~/.bitterbot/.env, or a saved profile", () => {
    const fromEnv = detectSetupKeys({ env: { GEMINI_API_KEY: GEMINI }, envFilePath, agentDir });
    expect(fromEnv.map((k) => [k.id, k.provider, k.masked])).toEqual([
      ["env:GEMINI_API_KEY", "google", "...5e6f"],
    ]);
    expect(JSON.stringify(fromEnv)).not.toContain(GEMINI);

    fs.writeFileSync(envFilePath, `GEMINI_API_KEY=${GEMINI}\n`);
    expect(detectSetupKeys({ env: {}, envFilePath, agentDir }).map((k) => k.id)).toEqual([
      "file:GEMINI_API_KEY",
    ]);

    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { "google:default": { type: "api_key", provider: "google", key: GEMINI } },
      }),
    );
    // The same value in the .env and the store is offered once, as saved.
    expect(detectSetupKeys({ env: {}, envFilePath, agentDir }).map((k) => k.id)).toEqual([
      "saved:google",
    ]);
  });

  it("offers one entry when the same key is in several places", () => {
    fs.writeFileSync(envFilePath, `ANTHROPIC_API_KEY=${ANTHROPIC}\n`);
    const keys = detectSetupKeys({ env: { ANTHROPIC_API_KEY: ANTHROPIC }, envFilePath, agentDir });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.source).toBe("env-file");
  });

  it("resolves an option id to its value on the server side only", () => {
    const opts = { env: { ANTHROPIC_API_KEY: ANTHROPIC }, envFilePath, agentDir };
    expect(resolveDetectedKey("env:ANTHROPIC_API_KEY", opts)?.value).toBe(ANTHROPIC);
    expect(resolveDetectedKey("env:NOT_A_KEY", opts)).toBeNull();
    expect(resolveDetectedKey("paste:anthropic", opts)).toBeNull();
  });
});

describe("storeProviderKey (ask once, remember)", () => {
  it("writes an Anthropic key once to the auth profile store, then finds it as saved", async () => {
    const config = await storeProviderKey({
      provider: "anthropic",
      key: ANTHROPIC,
      source: "environment",
      config: {},
      agentDir,
    });
    expect(config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(JSON.stringify(config)).not.toContain(ANTHROPIC);
    const store = JSON.parse(fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"));
    expect(store.profiles["anthropic:default"].key).toBe(ANTHROPIC);

    // The next setup run sees it as saved and offers it without the env var.
    const keys = detectSetupKeys({ env: {}, envFilePath, agentDir });
    expect(keys.map((k) => k.id)).toEqual(["saved:anthropic"]);
  });

  it("writes a Gemini key to the auth profile store as google:default", async () => {
    const config = await storeProviderKey({
      provider: "google",
      key: GEMINI,
      source: "pasted",
      config: {},
      agentDir,
    });
    expect(config.auth?.profiles?.["google:default"]).toMatchObject({
      provider: "google",
      mode: "api_key",
    });
    expect(JSON.stringify(config)).not.toContain(GEMINI);
    const store = JSON.parse(fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"));
    expect(store.profiles["google:default"]).toMatchObject({
      type: "api_key",
      provider: "google",
      key: GEMINI,
    });
    expect(detectSetupKeys({ env: {}, envFilePath, agentDir }).map((k) => k.id)).toEqual([
      "saved:google",
    ]);
  });

  it("writes an OpenAI key to the shared .env (the gateway loads it at start)", async () => {
    const env = { BITTERBOT_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const previous = process.env.OPENAI_API_KEY;
    try {
      await storeProviderKey({
        provider: "openai",
        key: OPENAI,
        source: "pasted",
        config: {},
        env,
        agentDir,
      });
      expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain(`OPENAI_API_KEY=${OPENAI}`);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

describe("storeProviderKey never destroys a different key", () => {
  const writeStore = (profiles: Record<string, unknown>) => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles }),
    );
  };
  const backups = (where: string, prefix: string) =>
    fs.readdirSync(where).filter((name) => name.startsWith(`${prefix}.bak-`));

  it("copies the auth store aside before replacing a different Anthropic key", async () => {
    writeStore({
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-OLD-key-123456" },
    });
    const notices: string[] = [];
    await storeProviderKey({
      provider: "anthropic",
      key: ANTHROPIC,
      source: "pasted",
      config: {},
      agentDir,
      onNotice: (m) => notices.push(m),
    });
    const store = JSON.parse(fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"));
    expect(store.profiles["anthropic:default"].key).toBe(ANTHROPIC);
    const [backup] = backups(agentDir, "auth-profiles.json");
    expect(backup).toBeDefined();
    const kept = JSON.parse(fs.readFileSync(path.join(agentDir, backup!), "utf8"));
    expect(kept.profiles["anthropic:default"].key).toBe("sk-ant-OLD-key-123456");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(agentDir, backup!)).mode & 0o777).toBe(0o600);
    }
    expect(notices.join("\n")).toContain(backup!);
    expect(notices.join("\n")).not.toContain("sk-ant-OLD");
  });

  it("keeps a setup-token sign-in the same way, and writes no backup for the same key", async () => {
    writeStore({
      "anthropic:default": { type: "token", provider: "anthropic", token: "tok-abcdefghijkl" },
    });
    await storeProviderKey({
      provider: "anthropic",
      key: ANTHROPIC,
      source: "pasted",
      config: {},
      agentDir,
    });
    expect(backups(agentDir, "auth-profiles.json")).toHaveLength(1);
    await storeProviderKey({
      provider: "anthropic",
      key: ANTHROPIC,
      source: "pasted",
      config: {},
      agentDir,
    });
    expect(backups(agentDir, "auth-profiles.json")).toHaveLength(1);
  });

  it("copies ~/.bitterbot/.env aside before replacing a different OpenAI key", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-OLD-openai-key-0000\n");
    const env = { BITTERBOT_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const previous = process.env.OPENAI_API_KEY;
    const notices: string[] = [];
    try {
      await storeProviderKey({
        provider: "openai",
        key: OPENAI,
        source: "pasted",
        config: {},
        env,
        agentDir,
        onNotice: (m) => notices.push(m),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain(`OPENAI_API_KEY=${OPENAI}`);
    const [backup] = backups(dir, ".env");
    expect(fs.readFileSync(path.join(dir, backup!), "utf8")).toContain("sk-OLD-openai-key-0000");
    expect(notices.join("\n")).toContain(backup!);
  });

  it("warns when the gateway's own environment has a different OpenAI key (dotenv will not override it)", async () => {
    const env = {
      BITTERBOT_STATE_DIR: dir,
      OPENAI_API_KEY: "sk-shell-stale-key-9999",
    } as NodeJS.ProcessEnv;
    const previous = process.env.OPENAI_API_KEY;
    const notices: string[] = [];
    try {
      await storeProviderKey({
        provider: "openai",
        key: OPENAI,
        source: "pasted",
        config: {},
        env,
        agentDir,
        onNotice: (m) => notices.push(m),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
    expect(notices.join("\n")).toContain("also set in the gateway's environment");
    expect(notices.join("\n")).not.toContain("sk-shell-stale");
  });

  it("uses an environment key in place when asked not to persist it (--non-interactive)", async () => {
    const config = await storeProviderKey({
      provider: "anthropic",
      key: ANTHROPIC,
      source: "environment",
      config: {},
      agentDir,
      persistEnvironmentKey: false,
    });
    expect(config).toEqual({});
    expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
  });
});

describe("detectSignedInProfiles", () => {
  it("lists OAuth and token sign-ins (never their secrets), not API keys or expired tokens", () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "SECRET-access",
            refresh: "SECRET-refresh",
            expires: Date.now() + 60_000,
            email: "me@example.com",
          },
          "anthropic:claude": { type: "token", provider: "anthropic", token: "SECRET-token" },
          "anthropic:old": {
            type: "token",
            provider: "anthropic",
            token: "SECRET-old",
            expires: 1,
          },
          "openrouter:default": { type: "api_key", provider: "openrouter", key: "SECRET-key" },
        },
      }),
    );
    const profiles = detectSignedInProfiles(agentDir);
    expect(profiles.map((p) => [p.id, p.mode])).toEqual([
      ["profile:openai-codex:default", "oauth"],
      ["profile:anthropic:claude", "token"],
    ]);
    expect(JSON.stringify(profiles)).not.toContain("SECRET");
  });
});

describe("validatePastedKey", () => {
  it("rejects empty, spaced and too-short pastes", () => {
    expect(validatePastedKey("")).toBeDefined();
    expect(validatePastedKey("sk ant 123456789")).toBeDefined();
    expect(validatePastedKey("abc")).toBeDefined();
    expect(validatePastedKey(ANTHROPIC)).toBeUndefined();
  });
});
