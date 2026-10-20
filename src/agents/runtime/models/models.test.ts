/**
 * Standalone tests for the owned AuthStorage / ModelRegistry. These stay when
 * the pi-coding-agent dependency goes: they import only this directory and
 * pi-ai. The expected strings here were pinned against pi 0.73.1 by
 * `models.differential.test.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Api,
  getModels,
  getProviders,
  type Model,
  type OAuthCredentials,
  resetApiProviders,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import lockfileModule from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthStorage,
  clearApiKeyCache,
  discoverAuthStorage,
  discoverModels,
  ModelRegistry,
} from "./index.js";
import { validateModelsConfig } from "./models-json-schema.js";
import {
  clearConfigValueCache,
  resolveConfigValue,
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

// The repo's ambient declaration of proper-lockfile has no lockSync.
const lockfile = lockfileModule as unknown as {
  lockSync(file: string, options?: { realpath?: boolean }): () => void;
};

const tempDirs: string[] = [];
const isWindows = process.platform === "win32";
const FUTURE = 4102444800000; // 2100-01-01

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  resetOAuthProviders();
  resetApiProviders();
  clearConfigValueCache();
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-models-"));
  tempDirs.push(dir);
  return dir;
}

function agentDir(files: { models?: unknown; auth?: unknown } = {}): string {
  const dir = makeDir();
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  if (files.models !== undefined) {
    write("models.json", files.models);
  }
  if (files.auth !== undefined) {
    write("auth.json", files.auth);
  }
  return dir;
}

function load(files: { models?: unknown; auth?: unknown } = {}) {
  const dir = agentDir(files);
  const authStorage = discoverAuthStorage(dir);
  const registry = discoverModels(authStorage, dir);
  return { dir, authStorage, registry };
}

const customProvider = (extra: Record<string, unknown> = {}) => ({
  providers: {
    mine: {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "literal-key",
      api: "openai-completions",
      models: [{ id: "m" }],
      ...extra,
    },
  },
});

describe("resolveConfigValue", () => {
  it("prefers the environment variable of that name, else the literal", () => {
    vi.stubEnv("BB_MODELS_TEST_VALUE", "from-env");
    expect(resolveConfigValue("BB_MODELS_TEST_VALUE")).toBe("from-env");
    vi.stubEnv("BB_MODELS_TEST_VALUE", "");
    expect(resolveConfigValue("BB_MODELS_TEST_VALUE")).toBe("BB_MODELS_TEST_VALUE");
    expect(resolveConfigValue("sk-literal")).toBe("sk-literal");
  });

  it.skipIf(isWindows)("runs a command once and caches the result, failures included", () => {
    const dir = makeDir();
    const counter = path.join(dir, "count");
    const command = `!echo run >> "${counter}"; echo "  secret  "`;
    expect(resolveConfigValue(command)).toBe("secret");
    expect(resolveConfigValue(command)).toBe("secret");
    expect(fs.readFileSync(counter, "utf8")).toBe("run\n");

    const failing = `!echo run >> "${counter}"; exit 1`;
    expect(resolveConfigValue(failing)).toBeUndefined();
    expect(resolveConfigValue(failing)).toBeUndefined();
    expect(fs.readFileSync(counter, "utf8")).toBe("run\nrun\n");

    clearConfigValueCache();
    expect(resolveConfigValue(command)).toBe("secret");
    expect(fs.readFileSync(counter, "utf8")).toBe("run\nrun\nrun\n");
  });

  it.skipIf(isWindows)("the uncached variant runs the command every time", () => {
    const dir = makeDir();
    const counter = path.join(dir, "count");
    const command = `!echo run >> "${counter}"; echo value`;
    expect(resolveConfigValueUncached(command)).toBe("value");
    expect(resolveConfigValueUncached(command)).toBe("value");
    expect(fs.readFileSync(counter, "utf8")).toBe("run\nrun\n");
  });

  it.skipIf(isWindows)("OrThrow names the command, never its output", () => {
    expect(resolveConfigValueOrThrow("!echo ok", "API key")).toBe("ok");
    expect(() => resolveConfigValueOrThrow("!echo leaked; exit 1", "API key")).toThrow(
      "Failed to resolve API key from shell command: echo leaked; exit 1",
    );
    // Empty output counts as a failure.
    expect(() => resolveConfigValueOrThrow("!true", 'provider "p" header "H"')).toThrow(
      'Failed to resolve provider "p" header "H" from shell command: true',
    );
  });

  it("resolveHeadersOrThrow resolves each value and maps no headers to undefined", () => {
    vi.stubEnv("BB_MODELS_TEST_HEADER", "h-env");
    expect(resolveHeadersOrThrow(undefined, "x")).toBeUndefined();
    expect(resolveHeadersOrThrow({}, "x")).toBeUndefined();
    expect(resolveHeadersOrThrow({ A: "BB_MODELS_TEST_HEADER", B: "lit" }, "x")).toStrictEqual({
      A: "h-env",
      B: "lit",
    });
  });
});

describe("validateModelsConfig", () => {
  it("accepts a valid config and returns it unchanged", () => {
    const config = customProvider({ compat: { supportsStore: false }, extraKey: 1 });
    const result = validateModelsConfig(config);
    expect(result).toStrictEqual({ ok: true, config });
    expect(result.ok && result.config).toBe(config);
  });

  it("reports type, required, minLength, const and anyOf errors in typebox's words", () => {
    const check = (value: unknown) => {
      const result = validateModelsConfig(value);
      return result.ok ? "ok" : result.errors;
    };
    expect(check(null)).toBe("  - root: must be object");
    expect(check({})).toBe("  - providers: must have required properties providers");
    expect(check({ providers: [] })).toBe("  - providers: must be object");
    expect(check({ providers: { p: { name: "", authHeader: 1 } } })).toBe(
      [
        "  - providers.p.name: must not have fewer than 1 characters",
        "  - providers.p.authHeader: must be boolean",
      ].join("\n"),
    );
    expect(check({ providers: { p: { models: [{ cost: {} }] } } })).toBe(
      [
        "  - providers.p.models.0.id: must have required properties id",
        "  - providers.p.models.0.cost.input: must have required properties input, output, cacheRead, cacheWrite",
      ].join("\n"),
    );
    expect(check({ providers: { p: { models: [{ id: "m", input: ["audio"] }] } } })).toBe(
      [
        "  - providers.p.models.0.input.0: must be equal to constant",
        "  - providers.p.models.0.input.0: must be equal to constant",
        "  - providers.p.models.0.input.0: must match a schema in anyOf",
      ].join("\n"),
    );
    // JSON Pointer escapes stay in the path.
    expect(check({ providers: { "a/b~c": 1 } })).toBe("  - providers.a~1b~0c: must be object");
  });

  it("stops at 8 errors", () => {
    const models = Array.from({ length: 20 }, () => ({ id: 1 }));
    const result = validateModelsConfig({ providers: { p: { models } } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.split("\n")).toHaveLength(8);
  });

  it("accepts any object as compat (pi quirk) but not a non-object", () => {
    expect(
      validateModelsConfig({ providers: { p: { compat: { supportsStore: "yes" } } } }).ok,
    ).toBe(true);
    const result = validateModelsConfig({ providers: { p: { compat: "x" } } });
    expect(!result.ok && result.errors.split("\n")).toStrictEqual([
      "  - providers.p.compat: must be object",
      "  - providers.p.compat: must be object",
      "  - providers.p.compat: must be object",
      "  - providers.p.compat: must match a schema in anyOf",
    ]);
  });
});

describe("AuthStorage", () => {
  it("creates auth.json as {} (0600) in a 0700 directory and leaves no lock", () => {
    const dir = makeDir();
    const authPath = path.join(dir, "nested", "agent", "auth.json");
    const storage = AuthStorage.create(authPath);
    expect(fs.readFileSync(authPath, "utf8")).toBe("{}");
    expect(storage.list()).toStrictEqual([]);
    expect(fs.existsSync(`${authPath}.lock`)).toBe(false);
    if (!isWindows) {
      expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(authPath)).mode & 0o077).toBe(0);
    }
  });

  it("writes pretty JSON with no trailing newline, keeps mode 0600, merges with disk", () => {
    const dir = agentDir({ auth: { openai: { type: "api_key", key: "first" } } });
    const authPath = path.join(dir, "auth.json");
    if (!isWindows) {
      fs.chmodSync(authPath, 0o644);
    }
    const storage = AuthStorage.create(authPath);
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        openai: { type: "api_key", key: "first" },
        external: { type: "api_key", key: "x" },
      }),
    );
    storage.set("zai", { type: "api_key", key: "z" });
    storage.remove("openai");
    expect(fs.readFileSync(authPath, "utf8")).toBe(
      [
        "{",
        '  "external": {',
        '    "type": "api_key",',
        '    "key": "x"',
        "  },",
        '  "zai": {',
        '    "type": "api_key",',
        '    "key": "z"',
        "  }",
        "}",
      ].join("\n"),
    );
    if (!isWindows) {
      expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
    }
    expect(storage.list()).toStrictEqual(["zai"]);
    storage.reload();
    expect(storage.list()).toStrictEqual(["external", "zai"]);
    expect(storage.getAll()).not.toBe(storage.getAll());
    expect(storage.drainErrors()).toStrictEqual([]);
  });

  it("does not overwrite a corrupt auth.json", () => {
    const dir = agentDir({ auth: "{ corrupt" });
    const authPath = path.join(dir, "auth.json");
    const storage = AuthStorage.create(authPath);
    storage.set("openai", { type: "api_key", key: "k" });
    expect(fs.readFileSync(authPath, "utf8")).toBe("{ corrupt");
    expect(storage.has("openai")).toBe(true);
    const errors = storage.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SyntaxError);
    expect(storage.drainErrors()).toStrictEqual([]);
  });

  it("a lock held elsewhere makes the load fail: no credentials, no writes, until reload", () => {
    const dir = agentDir({ auth: { openai: { type: "api_key", key: "k" } } });
    const authPath = path.join(dir, "auth.json");
    const before = fs.readFileSync(authPath, "utf8");
    const release = lockfile.lockSync(authPath, { realpath: false });
    let storage: AuthStorage;
    try {
      storage = AuthStorage.create(authPath);
      expect(storage.list()).toStrictEqual([]);
      storage.set("zai", { type: "api_key", key: "z" });
    } finally {
      release();
    }
    expect(fs.readFileSync(authPath, "utf8")).toBe(before);
    expect(storage.drainErrors().map((error) => error.message)).toStrictEqual([
      "Lock file is already being held",
    ]);
    storage.reload();
    expect(storage.list()).toStrictEqual(["openai"]);
    storage.set("zai", { type: "api_key", key: "z" });
    expect(Object.keys(JSON.parse(fs.readFileSync(authPath, "utf8")) as object)).toStrictEqual([
      "openai",
      "zai",
    ]);
  });

  it("getApiKey precedence: runtime, stored key, environment, fallback", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const storage = AuthStorage.inMemory();
    expect(await storage.getApiKey("groq")).toBeUndefined();
    expect(storage.hasAuth("groq")).toBe(false);

    storage.setFallbackResolver((provider) => (provider === "groq" ? "fallback" : undefined));
    expect(await storage.getApiKey("groq")).toBe("fallback");
    expect(await storage.getApiKey("groq", { includeFallback: false })).toBeUndefined();
    expect(storage.hasAuth("groq")).toBe(true);

    vi.stubEnv("GROQ_API_KEY", "env");
    expect(await storage.getApiKey("groq")).toBe("env");

    storage.set("groq", { type: "api_key", key: "stored" });
    expect(await storage.getApiKey("groq")).toBe("stored");

    storage.setRuntimeApiKey("groq", "runtime");
    expect(await storage.getApiKey("groq")).toBe("runtime");

    storage.removeRuntimeApiKey("groq");
    expect(await storage.getApiKey("groq")).toBe("stored");

    storage.remove("groq");
    expect(await storage.getApiKey("groq")).toBe("env");
  });

  it("an unexpired OAuth entry beats the environment; an unknown OAuth provider yields nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    const storage = AuthStorage.inMemory({
      anthropic: { type: "oauth", refresh: "r", access: "oauth-access", expires: FUTURE },
      "bb-unknown": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
    });
    expect(await storage.getApiKey("anthropic")).toBe("oauth-access");
    expect(await storage.getApiKey("bb-unknown")).toBeUndefined();
    expect(storage.hasAuth("bb-unknown")).toBe(true);
  });

  describe("OAuth refresh", () => {
    const OAUTH_ID = "bb-test-oauth";
    const EXPIRED = { type: "oauth", refresh: "r1", access: "a1", expires: 1 } as const;
    const REFRESHED: OAuthCredentials = { refresh: "r2", access: "a2", expires: FUTURE };

    function fakeProvider(refreshToken: () => Promise<OAuthCredentials>): { calls: number } {
      const state = { calls: 0 };
      registerOAuthProvider({
        id: OAUTH_ID,
        name: "Fake",
        login: async () => {
          throw new Error("not used");
        },
        refreshToken: async () => {
          state.calls++;
          return refreshToken();
        },
        getApiKey: (credentials) => `key:${credentials.access}`,
      });
      return state;
    }

    it("refreshes under the lock, persists, and does not refresh again", async () => {
      const state = fakeProvider(async () => REFRESHED);
      const dir = agentDir({ auth: { [OAUTH_ID]: EXPIRED } });
      const authPath = path.join(dir, "auth.json");
      const storage = AuthStorage.create(authPath);
      expect(await storage.getApiKey(OAUTH_ID)).toBe("key:a2");
      expect(await storage.getApiKey(OAUTH_ID)).toBe("key:a2");
      expect(state.calls).toBe(1);
      expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toStrictEqual({
        [OAUTH_ID]: { type: "oauth", ...REFRESHED },
      });
      expect(storage.get(OAUTH_ID)).toStrictEqual({ type: "oauth", ...REFRESHED });
      expect(fs.existsSync(`${authPath}.lock`)).toBe(false);
      if (!isWindows) {
        expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
      }
    });

    it("two instances over one file refresh once", async () => {
      const state = fakeProvider(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return REFRESHED;
      });
      const dir = agentDir({ auth: { [OAUTH_ID]: EXPIRED } });
      const authPath = path.join(dir, "auth.json");
      const a = AuthStorage.create(authPath);
      const b = AuthStorage.create(authPath);
      expect(await Promise.all([a.getApiKey(OAUTH_ID), b.getApiKey(OAUTH_ID)])).toStrictEqual([
        "key:a2",
        "key:a2",
      ]);
      expect(state.calls).toBe(1);
    });

    it("a failed refresh yields no key, keeps the credentials, records the error", async () => {
      fakeProvider(async () => {
        throw new Error("network down");
      });
      const dir = agentDir({ auth: { [OAUTH_ID]: EXPIRED } });
      const authPath = path.join(dir, "auth.json");
      const before = fs.readFileSync(authPath, "utf8");
      const storage = AuthStorage.create(authPath);
      storage.setFallbackResolver(() => "fallback");
      expect(await storage.getApiKey(OAUTH_ID)).toBeUndefined();
      expect(fs.readFileSync(authPath, "utf8")).toBe(before);
      expect(storage.drainErrors().map((error) => error.message)).toStrictEqual([
        `Failed to refresh OAuth token for ${OAUTH_ID}`,
      ]);
    });
  });
});

describe("ModelRegistry", () => {
  it("without models.json it is the pi-ai catalog, in order, by reference", () => {
    const { registry } = load();
    const expected = getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
    const all = registry.getAll();
    expect(registry.getError()).toBeUndefined();
    expect(all.length).toBe(expected.length);
    expect(all.every((model, index) => model === expected[index])).toBe(true);
    expect(registry.find("anthropic", expected.find((m) => m.provider === "anthropic")!.id)).toBe(
      expected.find((m) => m.provider === "anthropic"),
    );
    expect(registry.find("nope", "nope")).toBeUndefined();
    expect(ModelRegistry.inMemory(AuthStorage.inMemory()).getAll().length).toBe(expected.length);
  });

  it("adds custom models with defaults and keeps built-ins on a models.json error", () => {
    const builtInCount = load().registry.getAll().length;

    const ok = load({ models: customProvider() });
    expect(ok.registry.getAll().length).toBe(builtInCount + 1);
    expect(ok.registry.find("mine", "m")).toStrictEqual({
      id: "m",
      name: "m",
      api: "openai-completions",
      provider: "mine",
      baseUrl: "http://localhost:11434/v1",
      reasoning: false,
      thinkingLevelMap: undefined,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      headers: undefined,
      compat: undefined,
    });

    const broken = load({ models: "{ nope" });
    expect(broken.registry.getAll().length).toBe(builtInCount);
    expect(broken.registry.getError()).toMatch(/^Failed to parse models\.json: /);
    expect(broken.registry.getError()).toContain(
      `\n\nFile: ${path.join(broken.dir, "models.json")}`,
    );

    const invalid = load({ models: { providers: { mine: { models: [{}] } } } });
    expect(invalid.registry.getError()).toBe(
      `Invalid models.json schema:\n  - providers.mine.models.0.id: must have required properties id\n\nFile: ${path.join(invalid.dir, "models.json")}`,
    );

    const rejected = load({ models: { providers: { mine: { apiKey: "k" } } } });
    expect(rejected.registry.getError()).toBe(
      `Failed to load models.json: Provider mine: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".\n\nFile: ${path.join(rejected.dir, "models.json")}`,
    );
  });

  it("applies provider and per-model overrides to built-in models", () => {
    const first = getModels("anthropic")[0] as Model<Api>;
    const second = getModels("anthropic")[1] as Model<Api>;
    const { registry } = load({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://proxy.example",
            modelOverrides: {
              [first.id]: { name: "Renamed", cost: { input: 42 }, maxTokens: 7 },
            },
          },
        },
      },
    });
    const overridden = registry.find("anthropic", first.id) as Model<Api>;
    expect(overridden).toStrictEqual({
      ...first,
      baseUrl: "https://proxy.example",
      name: "Renamed",
      cost: { ...first.cost, input: 42 },
      maxTokens: 7,
      compat: first.compat,
    });
    expect(registry.find("anthropic", second.id)).toStrictEqual({
      ...second,
      baseUrl: "https://proxy.example",
      compat: second.compat,
    });
    // The catalog objects themselves are not mutated.
    expect(getModels("anthropic")[0].name).not.toBe("Renamed");
    // Position in the list is kept.
    const all = registry.getAll();
    const expectedIndex = getProviders()
      .flatMap((provider) => getModels(provider) as Model<Api>[])
      .indexOf(first);
    expect(all[expectedIndex]).toBe(overridden);
  });

  it("getAvailable / hasConfiguredAuth follow auth storage, env, and models.json apiKey", () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "x-env");
    const { registry, authStorage } = load({
      models: customProvider(),
      auth: { openai: { type: "api_key", key: "k" } },
    });
    const providers = () => new Set(registry.getAvailable().map((model) => model.provider));
    expect(providers().has("openai")).toBe(true);
    expect(providers().has("xai")).toBe(true);
    expect(providers().has("mine")).toBe(true);
    expect(providers().has("groq")).toBe(false);
    authStorage.setRuntimeApiKey("groq", "runtime");
    expect(providers().has("groq")).toBe(true);
    expect(registry.isUsingOAuth(registry.find("mine", "m") as Model<Api>)).toBe(false);
  });

  it("getApiKeyAndHeaders: shapes and error strings", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("BB_MODELS_TEST_KEY", "env-resolved");
    const { registry, authStorage } = load({
      models: {
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "BB_MODELS_TEST_KEY",
            api: "openai-completions",
            authHeader: true,
            headers: { "X-P": "p", "X-Shared": "provider" },
            models: [{ id: "m", headers: { "X-Shared": "model" } }, { id: "plain" }],
          },
          groq: { baseUrl: "https://groq.proxy", authHeader: true },
        },
      },
    });
    const model = registry.find("mine", "m") as Model<Api>;
    expect(await registry.getApiKeyAndHeaders(model)).toStrictEqual({
      ok: true,
      apiKey: "env-resolved",
      headers: { "X-P": "p", "X-Shared": "model", Authorization: "Bearer env-resolved" },
    });
    // Auth storage wins over the models.json key.
    authStorage.setRuntimeApiKey("mine", "runtime");
    expect(
      await registry.getApiKeyAndHeaders(registry.find("mine", "plain") as Model<Api>),
    ).toStrictEqual({
      ok: true,
      apiKey: "runtime",
      headers: { "X-P": "p", "X-Shared": "provider", Authorization: "Bearer runtime" },
    });

    const groq = registry.find("groq", getModels("groq")[0].id) as Model<Api>;
    expect(await registry.getApiKeyAndHeaders(groq)).toStrictEqual({
      ok: false,
      error: 'No API key found for "groq"',
    });

    // Nothing configured at all: ok with no key.
    const bare = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(await bare.getApiKeyAndHeaders(getModels("groq")[0] as Model<Api>)).toStrictEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it.skipIf(isWindows)(
    "a failing key command is an error naming the provider and command",
    async () => {
      const { registry } = load({ models: customProvider({ apiKey: "!exit 1" }) });
      const model = registry.find("mine", "m") as Model<Api>;
      expect(registry.hasConfiguredAuth(model)).toBe(true);
      expect(await registry.getApiKeyAndHeaders(model)).toStrictEqual({
        ok: false,
        error: 'Failed to resolve API key for provider "mine" from shell command: exit 1',
      });
      expect(clearApiKeyCache).toBe(clearConfigValueCache);
    },
  );

  it("registerProvider / unregisterProvider / refresh", async () => {
    const { registry, dir } = load({ models: customProvider() });
    const builtInOpenAi = getModels("openai")[0] as Model<Api>;
    expect(() =>
      registry.registerProvider("dyn", { models: [] as never, streamSimple: (() => {}) as never }),
    ).toThrow('Provider dyn: "api" is required when registering streamSimple.');
    registry.registerProvider("dyn", {
      baseUrl: "http://dyn",
      apiKey: "dyn-key",
      api: "openai-completions",
      models: [
        {
          id: "a",
          name: "A",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10,
          maxTokens: 5,
        },
      ],
    });
    registry.registerProvider("openai", { baseUrl: "https://openai.proxy" });
    expect(registry.find("openai", builtInOpenAi.id)?.baseUrl).toBe("https://openai.proxy");
    expect(
      await registry.getApiKeyAndHeaders(registry.find("dyn", "a") as Model<Api>),
    ).toStrictEqual({
      ok: true,
      apiKey: "dyn-key",
      headers: undefined,
    });

    // refresh() rereads models.json and re-applies registered providers.
    fs.rmSync(path.join(dir, "models.json"));
    registry.refresh();
    expect(registry.find("mine", "m")).toBeUndefined();
    expect(registry.find("dyn", "a")).toBeDefined();
    expect(registry.find("openai", builtInOpenAi.id)?.baseUrl).toBe("https://openai.proxy");

    registry.unregisterProvider("openai");
    registry.unregisterProvider("dyn");
    expect(registry.find("openai", builtInOpenAi.id)).toBe(builtInOpenAi);
    expect(registry.find("dyn", "a")).toBeUndefined();
  });

  it("OAuth modifyModels is applied for a stored OAuth credential", () => {
    const { registry } = load({
      auth: {
        "github-copilot": {
          type: "oauth",
          refresh: "r",
          access: "tid=1;proxy-ep=proxy.business.githubcopilot.com;",
          expires: FUTURE,
        },
      },
    });
    const copilot = registry.find(
      "github-copilot",
      getModels("github-copilot")[0].id,
    ) as Model<Api>;
    expect(copilot.baseUrl).toBe("https://api.business.githubcopilot.com");
    expect(registry.isUsingOAuth(copilot)).toBe(true);
  });
});

describe("discover helpers", () => {
  it("use auth.json and models.json inside the agent dir", () => {
    const dir = agentDir({
      models: customProvider(),
      auth: { openai: { type: "api_key", key: "k" } },
    });
    const authStorage = discoverAuthStorage(dir);
    const registry = discoverModels(authStorage, dir);
    expect(authStorage.list()).toStrictEqual(["openai"]);
    expect(registry.authStorage).toBe(authStorage);
    expect(registry.find("mine", "m")).toBeDefined();
  });
});
