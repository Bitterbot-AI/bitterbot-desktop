import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectSetupKeys,
  maskKeySuffix,
  resolveDetectedKey,
  storeProviderKey,
  validatePastedKey,
} from "./setup-keys.js";

const ANTHROPIC = "sk-ant-api03-SECRET-anthropic-value-9f2c";
const OPENAI = "sk-proj-SECRET-openai-value-77ab";
const OPENROUTER = "sk-or-v1-SECRET-openrouter-1234";

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

describe("validatePastedKey", () => {
  it("rejects empty, spaced and too-short pastes", () => {
    expect(validatePastedKey("")).toBeDefined();
    expect(validatePastedKey("sk ant 123456789")).toBeDefined();
    expect(validatePastedKey("abc")).toBeDefined();
    expect(validatePastedKey(ANTHROPIC)).toBeUndefined();
  });
});
