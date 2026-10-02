/**
 * Duck-typing test: pi's `createAgentSession` running on the OWNED
 * `AuthStorage` / `ModelRegistry` (cast to pi's types).
 *
 * This is what the transition needs: while the pi engine still exists, the
 * repo hands it the owned instances. The test runs real turns through pi's
 * session and pi's default stream function (which calls
 * `modelRegistry.getApiKeyAndHeaders`) against the scripted model, and checks
 * the provider received the key the owned registry resolved.
 *
 * DELETE THIS FILE when the `@mariozechner/pi-coding-agent` dependency goes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  type AuthStorage as PiAuthStorage,
  createAgentSession,
  type ModelRegistry as PiModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACT_API_KEY,
  SCRIPTED_API,
  SCRIPTED_PROVIDER,
  ScriptedModel,
} from "../contract/scripted-model.js";
import { AuthStorage, discoverAuthStorage, discoverModels, ModelRegistry } from "./index.js";

const tempDirs: string[] = [];
const scripts: ScriptedModel[] = [];

afterEach(() => {
  for (const script of scripts.splice(0)) {
    script.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-models-pi-session-"));
  tempDirs.push(dir);
  return dir;
}

function script(...texts: string[]): ScriptedModel {
  const scripted = new ScriptedModel(texts.map((text) => ({ kind: "text" as const, text })));
  scripts.push(scripted);
  return scripted;
}

async function createPiSession(params: {
  dir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
}) {
  const { session } = await createAgentSession({
    cwd: params.dir,
    agentDir: params.dir,
    // The owned classes are not pi's classes (pi's have private fields, so a
    // cast is always needed); pi's session only calls the methods they share.
    authStorage: params.authStorage as unknown as PiAuthStorage,
    modelRegistry: params.modelRegistry as unknown as PiModelRegistry,
    model: params.model,
    thinkingLevel: "off",
    tools: [],
    sessionManager: SessionManager.inMemory(params.dir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  return session;
}

function lastAssistantText(messages: unknown[]): string {
  const last = messages.at(-1) as { role?: string; content?: Array<{ text?: string }> };
  expect(last.role).toBe("assistant");
  return (last.content ?? []).map((block) => block.text ?? "").join("");
}

describe("pi createAgentSession on the owned AuthStorage / ModelRegistry", () => {
  it("runs a turn with in-memory instances; the provider receives the stored key", async () => {
    const dir = makeDir();
    const scripted = script("hello from the script");
    const authStorage = AuthStorage.inMemory({
      [SCRIPTED_PROVIDER]: { type: "api_key", key: CONTRACT_API_KEY },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const session = await createPiSession({
      dir,
      authStorage,
      modelRegistry,
      model: scripted.model,
    });

    // pi's session exposes the very instance it was given.
    expect(session.modelRegistry as unknown).toBe(modelRegistry);

    await session.prompt("hi");

    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0].apiKey).toBe(CONTRACT_API_KEY);
    expect(scripted.remaining).toBe(0);
    expect(lastAssistantText(session.messages)).toBe("hello from the script");
    session.dispose();
  });

  it("a runtime key override set after session creation reaches the next turn", async () => {
    const dir = makeDir();
    const scripted = script("one", "two");
    const authStorage = AuthStorage.inMemory({
      [SCRIPTED_PROVIDER]: { type: "api_key", key: CONTRACT_API_KEY },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const session = await createPiSession({
      dir,
      authStorage,
      modelRegistry,
      model: scripted.model,
    });

    await session.prompt("first");
    authStorage.setRuntimeApiKey(SCRIPTED_PROVIDER, "runtime-key");
    await session.prompt("second");

    expect(scripted.calls.map((call) => call.apiKey)).toStrictEqual([
      CONTRACT_API_KEY,
      "runtime-key",
    ]);
    session.dispose();
  });

  it("runs on file-backed instances with a models.json provider", async () => {
    vi.stubEnv("BB_MODELS_PI_SESSION_KEY", "key-from-env-name");
    const dir = makeDir();
    const scripted = script("from custom provider");
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          "contract-custom": {
            baseUrl: scripted.model.baseUrl,
            api: SCRIPTED_API,
            apiKey: "BB_MODELS_PI_SESSION_KEY",
            models: [{ id: "custom-scripted", contextWindow: 200000, maxTokens: 8000 }],
          },
        },
      }),
    );
    const authStorage = discoverAuthStorage(dir);
    const modelRegistry = discoverModels(authStorage, dir);
    expect(modelRegistry.getError()).toBeUndefined();
    const model = modelRegistry.find("contract-custom", "custom-scripted");
    expect(model).toBeDefined();

    const session = await createPiSession({
      dir,
      authStorage,
      modelRegistry,
      model: model as Model<Api>,
    });
    await session.prompt("hi");

    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0].apiKey).toBe("key-from-env-name");
    expect(lastAssistantText(session.messages)).toBe("from custom provider");
    session.dispose();
  });

  it("pi's session refuses to prompt when the owned registry has no auth for the model", async () => {
    const dir = makeDir();
    const scripted = script("never sent");
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const session = await createPiSession({
      dir,
      authStorage,
      modelRegistry,
      model: scripted.model,
    });

    await expect(session.prompt("hi")).rejects.toThrow(/No API key found/);
    expect(scripted.calls).toHaveLength(0);
    session.dispose();
  });
});
