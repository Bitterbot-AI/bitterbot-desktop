/**
 * Differential test: pi-coding-agent 0.73.1 `AuthStorage` / `ModelRegistry`
 * against the owned port in this directory.
 *
 * DELETE THIS FILE when the `@mariozechner/pi-coding-agent` dependency goes;
 * `models.test.ts` is the suite that stays.
 *
 * Each case builds pi's classes and ours over copies of the same fixture
 * files (one temp dir per implementation) and asserts equal results for the
 * surface the repo and pi's session use. Paths inside error strings are
 * normalized to `<DIR>` before comparing.
 *
 * Compared: `getAll()` (every model, order and key order included),
 * `getAvailable()`, `find`, `getError()`, `hasConfiguredAuth`,
 * `isUsingOAuth`, `getApiKeyAndHeaders` (success and error paths),
 * `registerProvider` / `unregisterProvider` / `refresh`, and on the storage
 * `list`, `get`, `has`, `hasAuth`, `getAll`, `getApiKey` precedence,
 * `drainErrors`, the bytes and mode of auth.json after writes.
 *
 * OAuth refresh IS compared, without network: both implementations refresh
 * through pi-ai's `getOAuthApiKey`, so a fake OAuth provider registered with
 * pi-ai's provider registry drives the expired-token path of both. What is
 * not exercised is the real token endpoints of the built-in providers
 * (Anthropic, GitHub Copilot, OpenAI Codex): that code is pi-ai's and is
 * shared, not ported.
 *
 * Not compared: Windows shell selection for "!command" values (the test runs
 * the platform's default path only), and lock contention between separate
 * processes (two instances in one process are compared instead).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Api,
  createAssistantMessageEventStream,
  getModels,
  type Model,
  type OAuthCredentials,
  type OAuthProviderInterface,
  resetApiProviders,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import lockfileModule from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthStorageData, ModelRegistry } from "./index.js";

// The repo's ambient declaration of proper-lockfile has no lockSync.
const lockfile = lockfileModule as unknown as {
  lockSync(file: string, options?: { realpath?: boolean }): () => void;
};

type Content = string | ((dir: string) => string);

type Side<A, R> = { dir: string; authPath: string; modelsPath: string; auth: A; registry: R };

type Pair = {
  pi: Side<PiAuthStorage, PiModelRegistry>;
  own: Side<AuthStorage, ModelRegistry>;
};

const tempDirs: string[] = [];
const isWindows = process.platform === "win32";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  // refresh() / registerProvider() touch pi-ai's process-wide registries.
  resetOAuthProviders();
  resetApiProviders();
});

function makeDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bb-models-diff-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeFixtures(dir: string, fixture: { models?: Content; auth?: Content }): void {
  const resolve = (content: Content) => (typeof content === "function" ? content(dir) : content);
  if (fixture.models !== undefined) {
    fs.writeFileSync(path.join(dir, "models.json"), resolve(fixture.models));
  }
  if (fixture.auth !== undefined) {
    fs.writeFileSync(path.join(dir, "auth.json"), resolve(fixture.auth));
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function makePair(fixture: { models?: Content; auth?: Content } = {}): Pair {
  const piDir = makeDir("pi");
  const ownDir = makeDir("own");
  writeFixtures(piDir, fixture);
  writeFixtures(ownDir, fixture);
  const piAuthPath = path.join(piDir, "auth.json");
  const ownAuthPath = path.join(ownDir, "auth.json");
  const piModelsPath = path.join(piDir, "models.json");
  const ownModelsPath = path.join(ownDir, "models.json");
  const piAuth = PiAuthStorage.create(piAuthPath);
  const ownAuth = AuthStorage.create(ownAuthPath);
  return {
    pi: {
      dir: piDir,
      authPath: piAuthPath,
      modelsPath: piModelsPath,
      auth: piAuth,
      registry: PiModelRegistry.create(piAuth, piModelsPath),
    },
    own: {
      dir: ownDir,
      authPath: ownAuthPath,
      modelsPath: ownModelsPath,
      auth: ownAuth,
      registry: ModelRegistry.create(ownAuth, ownModelsPath),
    },
  };
}

function norm(text: string | undefined, pair: Pair): string | undefined {
  return text?.split(pair.pi.dir).join("<DIR>").split(pair.own.dir).join("<DIR>");
}

/**
 * Element-wise comparison. A built-in model nobody touched is pi-ai's own
 * object in both lists; anything else must be deeply and strictly equal, with
 * the same key order.
 */
function expectSameModels(piModels: Model<Api>[], ownModels: Model<Api>[]): void {
  expect(ownModels.length).toBe(piModels.length);
  for (let i = 0; i < piModels.length; i++) {
    if (ownModels[i] === piModels[i]) {
      continue;
    }
    expect(ownModels[i]).toStrictEqual(piModels[i]);
    expect(JSON.stringify(ownModels[i])).toBe(JSON.stringify(piModels[i]));
  }
}

const UNKNOWN_MODEL = {
  id: "ghost",
  name: "ghost",
  api: "openai-completions",
  provider: "bb-unknown-provider",
  baseUrl: "https://ghost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<Api>;

const FIXED_PROBES: Array<[string, string]> = [
  ["anthropic", getModels("anthropic")[0].id],
  ["openai", getModels("openai")[0].id],
  ["github-copilot", getModels("github-copilot")[0].id],
  ["groq", getModels("groq")[0].id],
  ["openrouter", getModels("openrouter")[0].id],
  ["no-such-provider", "no-such-model"],
];

async function expectSameRegistry(
  pair: Pair,
  extraProbes: Array<[string, string]> = [],
): Promise<void> {
  const pi = pair.pi.registry;
  const own = pair.own.registry;
  expect(norm(own.getError(), pair)).toBe(norm(pi.getError(), pair));
  const piAll = pi.getAll();
  const ownAll = own.getAll();
  expectSameModels(piAll, ownAll);
  expectSameModels(pi.getAvailable(), own.getAvailable());

  // Probe every model that is not an untouched built-in (capped), plus fixed ones.
  const changed = piAll.filter((m, index) => m !== ownAll[index]);
  const probes: Array<[string, string]> = [
    ...FIXED_PROBES,
    ...extraProbes,
    ...changed.slice(0, 25).map((m): [string, string] => [m.provider, m.id]),
  ];
  for (const [provider, id] of probes) {
    const piModel = pi.find(provider, id);
    const ownModel = own.find(provider, id);
    if (piModel === undefined) {
      expect(ownModel).toBeUndefined();
      continue;
    }
    expect(ownModel).toStrictEqual(piModel);
    const found = ownModel as Model<Api>;
    expect(own.hasConfiguredAuth(found)).toBe(pi.hasConfiguredAuth(piModel));
    expect(own.isUsingOAuth(found)).toBe(pi.isUsingOAuth(piModel));
    await expectSameRequestAuth(pair, piModel, found);
  }
  expect(own.hasConfiguredAuth(UNKNOWN_MODEL)).toBe(pi.hasConfiguredAuth(UNKNOWN_MODEL));
  expect(own.isUsingOAuth(UNKNOWN_MODEL)).toBe(pi.isUsingOAuth(UNKNOWN_MODEL));
  await expectSameRequestAuth(pair, UNKNOWN_MODEL, UNKNOWN_MODEL);
}

async function expectSameRequestAuth(
  pair: Pair,
  piModel: Model<Api>,
  ownModel: Model<Api>,
): Promise<void> {
  const piAuth = await pair.pi.registry.getApiKeyAndHeaders(piModel);
  const ownAuth = await pair.own.registry.getApiKeyAndHeaders(ownModel);
  const normalize = (result: typeof piAuth) =>
    result.ok ? result : { ok: false, error: norm(result.error, pair) };
  expect(normalize(ownAuth)).toStrictEqual(normalize(piAuth));
}

function readAuthFile(pair: Pair, side: "pi" | "own"): string | undefined {
  return norm(fs.readFileSync(pair[side].authPath, "utf8"), pair);
}

async function expectSameAuth(pair: Pair, providers: string[]): Promise<void> {
  const pi = pair.pi.auth;
  const own = pair.own.auth;
  expect(own.list()).toStrictEqual(pi.list());
  expect(norm(json(own.getAll()), pair)).toBe(norm(json(pi.getAll()), pair));
  for (const provider of providers) {
    expect(norm(json(own.get(provider)), pair)).toBe(norm(json(pi.get(provider)), pair));
    expect(own.has(provider)).toBe(pi.has(provider));
    expect(own.hasAuth(provider)).toBe(pi.hasAuth(provider));
    expect(await own.getApiKey(provider)).toBe(await pi.getApiKey(provider));
    expect(await own.getApiKey(provider, { includeFallback: false })).toBe(
      await pi.getApiKey(provider, { includeFallback: false }),
    );
  }
  expect(readAuthFile(pair, "own")).toBe(readAuthFile(pair, "pi"));
  expect(fileMode(pair.own.authPath)).toBe(fileMode(pair.pi.authPath));
}

/** Permission bits, or 0 on Windows where they are not meaningful. */
function fileMode(file: string): number {
  return isWindows ? 0 : fs.statSync(file).mode & 0o777;
}

function expectSameDrainedErrors(pair: Pair): string[] {
  const piErrors = pair.pi.auth.drainErrors().map((e) => norm(e.message, pair));
  const ownErrors = pair.own.auth.drainErrors().map((e) => norm(e.message, pair));
  expect(ownErrors).toStrictEqual(piErrors);
  return ownErrors as string[];
}

const ANTHROPIC_ID = getModels("anthropic")[0].id;
const OPENROUTER_WITH_COMPAT = getModels("openrouter").find((m) => m.compat)?.id ?? "";

// ----------------------------------------------------------------------------
// models.json loading
// ----------------------------------------------------------------------------

describe("ModelRegistry: models.json loading matches pi", () => {
  const cases: Array<{ name: string; models?: Content; error?: RegExp | null }> = [
    { name: "no models.json", error: null },
    { name: "empty file", models: "", error: /^Failed to parse models\.json: / },
    { name: "invalid JSON", models: '{ "providers": ', error: /^Failed to parse models\.json: / },
    {
      name: "JSON null",
      models: "null",
      error: /^Invalid models\.json schema:\n {2}- root: must be object/,
    },
    { name: "JSON array", models: "[]", error: /root: must be object/ },
    {
      name: "missing providers",
      models: "{}",
      error: /providers: must have required properties providers/,
    },
    { name: "empty providers", models: json({ providers: {} }), error: null },
    {
      name: "schema: wrong types in several places",
      models: json({
        providers: {
          a: { name: "", apiKey: 5, authHeader: "yes", headers: { h: 1 }, compat: 7 },
          "b/c~d": { models: [{}, { id: "" }, { id: 5, input: ["audio", 1], cost: {} }] },
        },
      }),
      error: /^Invalid models\.json schema:/,
    },
    {
      name: "schema: several required properties missing in one object",
      models: json({
        providers: {
          a: { baseUrl: "u", api: "x", apiKey: "k", models: [{ id: "m", cost: { input: 1 } }] },
        },
      }),
      error:
        /providers\.a\.models\.0\.cost\.output: must have required properties output, cacheRead, cacheWrite/,
    },
    {
      name: "provider with nothing to configure",
      models: json({ providers: { anthropic: { apiKey: "k" } } }),
      error:
        /^Failed to load models\.json: Provider anthropic: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"\./,
    },
    {
      name: "custom provider without baseUrl",
      models: json({
        providers: { mine: { apiKey: "k", api: "openai-completions", models: [{ id: "m" }] } },
      }),
      error: /Provider mine: "baseUrl" is required when defining custom models\./,
    },
    {
      name: "custom provider without apiKey",
      models: json({
        providers: {
          mine: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] },
        },
      }),
      error: /Provider mine: "apiKey" is required when defining custom models\./,
    },
    {
      name: "custom provider without api",
      models: json({
        providers: { mine: { baseUrl: "http://x", apiKey: "k", models: [{ id: "m" }] } },
      }),
      error: /Provider mine, model m: no "api" specified\. Set at provider or model level\./,
    },
    {
      name: "invalid contextWindow",
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "k",
            api: "openai-completions",
            models: [{ id: "m", contextWindow: 0 }],
          },
        },
      }),
      error: /Provider mine, model m: invalid contextWindow/,
    },
    {
      name: "invalid maxTokens",
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "k",
            api: "openai-completions",
            models: [{ id: "m", maxTokens: -1 }],
          },
        },
      }),
      error: /Provider mine, model m: invalid maxTokens/,
    },
    {
      name: "custom provider with models, defaults, model-level api/baseUrl, compat merge",
      models: json({
        providers: {
          mine: {
            name: "Mine",
            baseUrl: "http://localhost:11434/v1",
            apiKey: "literal-key",
            api: "openai-completions",
            compat: {
              supportsDeveloperRole: false,
              openRouterRouting: { order: ["a"], allow_fallbacks: true },
              vercelGatewayRouting: { only: ["x"] },
            },
            models: [
              { id: "plain" },
              {
                id: "full",
                name: "Full",
                api: "openai-responses",
                baseUrl: "http://localhost:1/v1",
                reasoning: true,
                thinkingLevelMap: { off: null, high: "max" },
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                contextWindow: 4096,
                maxTokens: 512,
                headers: { "X-Model": "model-header" },
                compat: {
                  supportsStore: true,
                  openRouterRouting: { order: ["b"] },
                  vercelGatewayRouting: { order: ["y"] },
                },
              },
            ],
          },
        },
      }),
      error: null,
    },
    {
      name: "built-in provider: baseUrl + headers + compat override",
      models: json({
        providers: {
          anthropic: {
            baseUrl: "https://proxy.example/anthropic",
            headers: { "X-Proxy": "on" },
            compat: { supportsEagerToolInputStreaming: true },
          },
          openrouter: {
            compat: { openRouterRouting: { only: ["x"] }, thinkingFormat: "openrouter" },
          },
        },
      }),
      error: null,
    },
    {
      name: "built-in provider: headers only (no model objects change)",
      models: json({ providers: { openai: { headers: { "X-Only": "h" } } } }),
      error: null,
    },
    {
      name: "built-in provider: per-model overrides",
      models: json({
        providers: {
          anthropic: {
            modelOverrides: {
              [ANTHROPIC_ID]: {
                name: "Renamed",
                reasoning: true,
                thinkingLevelMap: { xhigh: null, low: "l" },
                input: ["text"],
                cost: { input: 99 },
                contextWindow: 1234,
                maxTokens: 56,
                headers: { "X-Override": "o" },
                compat: { supportsLongCacheRetention: false },
              },
              "not-a-built-in-id": { name: "ignored" },
            },
          },
          openrouter: {
            modelOverrides: {
              [OPENROUTER_WITH_COMPAT]: { compat: { openRouterRouting: { order: ["z"] } } },
            },
          },
        },
      }),
      error: null,
    },
    {
      name: "built-in provider: custom model added, and one replacing a built-in id",
      models: json({
        providers: {
          anthropic: {
            models: [{ id: "my-claude" }, { id: ANTHROPIC_ID, name: "Replaced", maxTokens: 7 }],
          },
        },
      }),
      error: null,
    },
    {
      name: "comments and trailing commas",
      models: `{
  // a comment
  "providers": {
    "mine": {
      "baseUrl": "http://localhost:1/v1", // trailing comment
      "apiKey": "k // not a comment",
      "api": "openai-completions",
      "models": [{ "id": "m", }, ],
    },
  },
}`,
      error: null,
    },
    {
      name: "number that overflows to Infinity",
      models:
        '{"providers":{"mine":{"baseUrl":"http://x","apiKey":"k","api":"openai-completions","models":[{"id":"m","contextWindow":1e999}]}}}',
      error: /providers\.mine\.models\.0\.contextWindow: must be number/,
    },
    {
      name: "provider named __proto__ and a model id with a lone surrogate",
      models:
        '{"providers":{"__proto__":{"baseUrl":"http://x","apiKey":"k","api":"openai-completions","models":[{"id":"\\ud83d"}]},"constructor":{"name":5}}}',
      error: /providers\.constructor\.name: must be string/,
    },
    {
      name: "byte order mark",
      models: '\ufeff{"providers":{}}',
      error: /^Failed to parse models\.json: /,
    },
    {
      name: "unknown keys are kept, compat of any object shape is accepted",
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "k",
            api: "openai-completions",
            somethingElse: { nested: true },
            compat: { supportsStore: "not-a-boolean", unknownFlag: 1 },
            models: [{ id: "m", extra: 1, compat: { maxTokensField: "nope" } }],
          },
        },
      }),
      error: null,
    },
    {
      name: "authHeader with literal apiKey and provider headers",
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "literal-key",
            api: "openai-completions",
            authHeader: true,
            headers: { "X-A": "a", "X-Empty": "" },
            models: [{ id: "m", headers: { "X-A": "model-wins", "X-M": "m" } }],
          },
        },
      }),
      error: null,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const pair = makePair({ models: testCase.models });
      if (testCase.error === null) {
        expect(pair.own.registry.getError()).toBeUndefined();
      } else if (testCase.error) {
        expect(pair.own.registry.getError()).toMatch(testCase.error);
        expect(pair.own.registry.getError()).toContain(`\n\nFile: ${pair.own.modelsPath}`);
      }
      await expectSameRegistry(pair, [
        ["mine", "plain"],
        ["mine", "full"],
        ["mine", "m"],
        ["anthropic", "my-claude"],
        ["anthropic", ANTHROPIC_ID],
        ["openrouter", OPENROUTER_WITH_COMPAT],
      ]);
    });
  }

  it("builds the expected custom model (explicit values, not only equality)", () => {
    const pair = makePair({
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x/v1",
            apiKey: "k",
            api: "openai-completions",
            models: [{ id: "m" }],
          },
        },
      }),
    });
    const expected = {
      id: "m",
      name: "m",
      api: "openai-completions",
      provider: "mine",
      baseUrl: "http://x/v1",
      reasoning: false,
      thinkingLevelMap: undefined,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      headers: undefined,
      compat: undefined,
    };
    expect(pair.own.registry.find("mine", "m")).toStrictEqual(expected);
    expect(pair.pi.registry.find("mine", "m")).toStrictEqual(expected);
    expect(pair.own.registry.getAll().at(-1)).toBe(pair.own.registry.find("mine", "m"));
  });
});

// ----------------------------------------------------------------------------
// Request auth: key sources, headers, error strings
// ----------------------------------------------------------------------------

describe("ModelRegistry.getApiKeyAndHeaders matches pi", () => {
  const provider = (apiKey: string | undefined, extra: Record<string, unknown> = {}) =>
    json({
      providers: {
        mine: {
          baseUrl: "http://x",
          ...(apiKey === undefined ? {} : { apiKey }),
          api: "openai-completions",
          models: [{ id: "m" }],
          ...extra,
        },
      },
    });

  it("apiKey as a literal", async () => {
    const pair = makePair({ models: provider("literal-key") });
    const model = pair.own.registry.find("mine", "m") as Model<Api>;
    expect(await pair.own.registry.getApiKeyAndHeaders(model)).toStrictEqual({
      ok: true,
      apiKey: "literal-key",
      headers: undefined,
    });
    await expectSameRegistry(pair, [["mine", "m"]]);
  });

  it("apiKey as an environment variable name, set and unset", async () => {
    const pair = makePair({ models: provider("BB_MODELS_DIFF_KEY") });
    const model = pair.own.registry.find("mine", "m") as Model<Api>;

    vi.stubEnv("BB_MODELS_DIFF_KEY", "from-env");
    expect(await pair.own.registry.getApiKeyAndHeaders(model)).toMatchObject({
      ok: true,
      apiKey: "from-env",
    });
    await expectSameRegistry(pair, [["mine", "m"]]);

    vi.stubEnv("BB_MODELS_DIFF_KEY", undefined);
    // pi quirk: an unset variable name is used as the literal key.
    expect(await pair.own.registry.getApiKeyAndHeaders(model)).toMatchObject({
      ok: true,
      apiKey: "BB_MODELS_DIFF_KEY",
    });
    await expectSameRegistry(pair, [["mine", "m"]]);
  });

  it.skipIf(isWindows)("apiKey as a command: executed on every call (uncached)", async () => {
    const command = (dir: string) => `!echo run >> "${dir}/count"; echo cmd-key`;
    const pair = makePair({ models: (dir) => provider(command(dir)) });
    const count = (dir: string) =>
      fs.existsSync(path.join(dir, "count"))
        ? fs.readFileSync(path.join(dir, "count"), "utf8").trim().split("\n").length
        : 0;
    for (const side of ["pi", "own"] as const) {
      const model = pair[side].registry.find("mine", "m") as Model<Api>;
      expect(count(pair[side].dir)).toBe(0);
      for (let i = 0; i < 3; i++) {
        expect(await pair[side].registry.getApiKeyAndHeaders(model)).toStrictEqual({
          ok: true,
          apiKey: "cmd-key",
          headers: undefined,
        });
      }
      expect(count(pair[side].dir)).toBe(3);
    }
  });

  it.skipIf(isWindows)("failing commands: api key, provider header, model header", async () => {
    const keyFails = makePair({ models: provider("!exit 3") });
    const ownKeyResult = await keyFails.own.registry.getApiKeyAndHeaders(
      keyFails.own.registry.find("mine", "m") as Model<Api>,
    );
    expect(ownKeyResult).toStrictEqual({
      ok: false,
      error: 'Failed to resolve API key for provider "mine" from shell command: exit 3',
    });
    await expectSameRegistry(keyFails, [["mine", "m"]]);

    const providerHeaderFails = makePair({
      models: provider("k", { headers: { "X-Good": "!echo good", "X-Bad": "!exit 1" } }),
    });
    expect(
      await providerHeaderFails.own.registry.getApiKeyAndHeaders(
        providerHeaderFails.own.registry.find("mine", "m") as Model<Api>,
      ),
    ).toStrictEqual({
      ok: false,
      error: 'Failed to resolve provider "mine" header "X-Bad" from shell command: exit 1',
    });
    await expectSameRegistry(providerHeaderFails, [["mine", "m"]]);

    const modelHeaderFails = makePair({
      models: provider("k", { models: [{ id: "m", headers: { "X-Bad": "!printf ''" } }] }),
    });
    expect(
      await modelHeaderFails.own.registry.getApiKeyAndHeaders(
        modelHeaderFails.own.registry.find("mine", "m") as Model<Api>,
      ),
    ).toStrictEqual({
      ok: false,
      error: `Failed to resolve model "mine/m" header "X-Bad" from shell command: printf ''`,
    });
    await expectSameRegistry(modelHeaderFails, [["mine", "m"]]);
  });

  it.skipIf(isWindows)("headers resolve like keys: env name, command, literal", async () => {
    vi.stubEnv("BB_MODELS_DIFF_HEADER", "header-from-env");
    const pair = makePair({
      models: provider("k", {
        headers: { "X-Env": "BB_MODELS_DIFF_HEADER", "X-Cmd": "!echo from-cmd", "X-Lit": "lit" },
      }),
    });
    expect(
      await pair.own.registry.getApiKeyAndHeaders(
        pair.own.registry.find("mine", "m") as Model<Api>,
      ),
    ).toStrictEqual({
      ok: true,
      apiKey: "k",
      headers: { "X-Env": "header-from-env", "X-Cmd": "from-cmd", "X-Lit": "lit" },
    });
    await expectSameRegistry(pair, [["mine", "m"]]);
  });

  it("authHeader adds a Bearer header; without a key it is the 'No API key found' error", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const withKey = makePair({ models: provider("k", { authHeader: true }) });
    expect(
      await withKey.own.registry.getApiKeyAndHeaders(
        withKey.own.registry.find("mine", "m") as Model<Api>,
      ),
    ).toStrictEqual({ ok: true, apiKey: "k", headers: { Authorization: "Bearer k" } });
    await expectSameRegistry(withKey, [["mine", "m"]]);

    const withoutKey = makePair({
      models: json({ providers: { groq: { baseUrl: "https://groq.proxy", authHeader: true } } }),
    });
    const groqModel = withoutKey.own.registry.find("groq", getModels("groq")[0].id) as Model<Api>;
    expect(groqModel.baseUrl).toBe("https://groq.proxy");
    expect(await withoutKey.own.registry.getApiKeyAndHeaders(groqModel)).toStrictEqual({
      ok: false,
      error: 'No API key found for "groq"',
    });
    expect(withoutKey.own.registry.hasConfiguredAuth(groqModel)).toBe(false);
    await expectSameRegistry(withoutKey);

    // The same config with the environment key present.
    vi.stubEnv("GROQ_API_KEY", "groq-env");
    expect(await withoutKey.own.registry.getApiKeyAndHeaders(groqModel)).toStrictEqual({
      ok: true,
      apiKey: "groq-env",
      headers: { Authorization: "Bearer groq-env" },
    });
    await expectSameRegistry(withoutKey);
  });

  it("no auth at all is ok:true with no key (pi quirk), and auth storage beats models.json", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const none = makePair();
    const groqModel = none.own.registry.find("groq", getModels("groq")[0].id) as Model<Api>;
    expect(await none.own.registry.getApiKeyAndHeaders(groqModel)).toStrictEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
    await expectSameRegistry(none);

    const both = makePair({
      models: provider("models-json-key"),
      auth: json({ mine: { type: "api_key", key: "auth-json-key" } }),
    });
    expect(
      await both.own.registry.getApiKeyAndHeaders(
        both.own.registry.find("mine", "m") as Model<Api>,
      ),
    ).toMatchObject({ ok: true, apiKey: "auth-json-key" });
    await expectSameRegistry(both, [["mine", "m"]]);

    // A fallback resolver on the storage is NOT consulted by the registry.
    for (const side of ["pi", "own"] as const) {
      none[side].auth.setFallbackResolver(() => "fallback-key");
    }
    expect(await none.own.registry.getApiKeyAndHeaders(groqModel)).toMatchObject({
      ok: true,
      apiKey: undefined,
    });
    expect(none.own.registry.hasConfiguredAuth(groqModel)).toBe(true);
    await expectSameRegistry(none);
  });

  it("model.headers on the model object are merged under provider and model headers", async () => {
    const pair = makePair({
      models: provider("k", {
        headers: { "X-Shared": "provider", "X-P": "p" },
        models: [{ id: "m", headers: { "X-Shared": "model" } }],
      }),
    });
    const withHeaders = (side: "pi" | "own") => ({
      ...(pair[side].registry.find("mine", "m") as Model<Api>),
      headers: { "X-Shared": "object", "X-O": "o" },
    });
    const ownResult = await pair.own.registry.getApiKeyAndHeaders(withHeaders("own"));
    expect(ownResult).toStrictEqual({
      ok: true,
      apiKey: "k",
      headers: { "X-Shared": "model", "X-O": "o", "X-P": "p" },
    });
    expect(await pair.pi.registry.getApiKeyAndHeaders(withHeaders("pi"))).toStrictEqual(ownResult);
  });
});

// ----------------------------------------------------------------------------
// AuthStorage
// ----------------------------------------------------------------------------

describe("AuthStorage matches pi", () => {
  const FUTURE = 4102444800000; // 2100-01-01

  it("creates auth.json as {} with mode 0600 and the parent dir with 0700", async () => {
    const piDir = makeDir("pi");
    const ownDir = makeDir("own");
    const piPath = path.join(piDir, "nested", "agent", "auth.json");
    const ownPath = path.join(ownDir, "nested", "agent", "auth.json");
    PiAuthStorage.create(piPath);
    AuthStorage.create(ownPath);
    expect(fs.readFileSync(ownPath, "utf8")).toBe("{}");
    expect(fs.readFileSync(ownPath, "utf8")).toBe(fs.readFileSync(piPath, "utf8"));
    if (!isWindows) {
      const mode = (file: string) => fs.statSync(file).mode & 0o777;
      expect(mode(ownPath)).toBe(0o600);
      expect(mode(ownPath)).toBe(mode(piPath));
      expect(mode(path.dirname(ownPath))).toBe(mode(path.dirname(piPath)));
      expect(mode(path.dirname(ownPath)) & 0o077).toBe(0);
    }
    // No lock is left behind.
    expect(fs.existsSync(`${ownPath}.lock`)).toBe(false);
  });

  it("reads api_key and unexpired OAuth entries", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    const pair = makePair({
      auth: json({
        openai: { type: "api_key", key: "sk-stored" },
        anthropic: { type: "oauth", refresh: "r", access: "oauth-access", expires: FUTURE },
        "github-copilot": {
          type: "oauth",
          refresh: "r",
          access: "tid=1;exp=9;proxy-ep=proxy.business.githubcopilot.com;",
          expires: FUTURE,
          enterpriseUrl: "ghe.example.com",
        },
        "bb-unknown-oauth": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
      }),
    });
    // OAuth beats the environment variable.
    expect(await pair.own.auth.getApiKey("anthropic")).toBe("oauth-access");
    // A stored OAuth entry for an unknown provider yields nothing.
    expect(await pair.own.auth.getApiKey("bb-unknown-oauth")).toBeUndefined();
    expect(pair.own.auth.getOAuthProviders()).toStrictEqual(pair.pi.auth.getOAuthProviders());
    await expectSameAuth(pair, [
      "openai",
      "anthropic",
      "github-copilot",
      "bb-unknown-oauth",
      "groq",
      "nope",
    ]);
    // OAuth modifyModels (Copilot base URL from the token) and isUsingOAuth.
    const copilot = pair.own.registry.find("github-copilot", getModels("github-copilot")[0].id);
    expect(copilot?.baseUrl).toBe("https://api.business.githubcopilot.com");
    expect(pair.own.registry.isUsingOAuth(copilot as Model<Api>)).toBe(true);
    await expectSameRegistry(pair);
    expect(expectSameDrainedErrors(pair)).toStrictEqual([]);
  });

  it("getApiKey precedence: runtime, stored key, environment, fallback", async () => {
    const pair = makePair();
    const both = (fn: (auth: PiAuthStorage | AuthStorage) => void) => {
      fn(pair.pi.auth);
      fn(pair.own.auth);
    };
    const check = async (expected: string | undefined, fromFallback = false) => {
      expect(await pair.own.auth.getApiKey("groq")).toBe(expected);
      expect(await pair.own.auth.getApiKey("groq", { includeFallback: false })).toBe(
        fromFallback ? undefined : expected,
      );
      await expectSameAuth(pair, ["groq"]);
    };

    vi.stubEnv("GROQ_API_KEY", "");
    await check(undefined);
    expect(pair.own.auth.hasAuth("groq")).toBe(false);

    both((auth) => auth.setFallbackResolver((p) => (p === "groq" ? "fallback-key" : undefined)));
    await check("fallback-key", true);
    expect(pair.own.auth.hasAuth("groq")).toBe(true);

    vi.stubEnv("GROQ_API_KEY", "env-key");
    await check("env-key");

    both((auth) => auth.set("groq", { type: "api_key", key: "stored-key" }));
    await check("stored-key");

    both((auth) => auth.setRuntimeApiKey("groq", "runtime-key"));
    await check("runtime-key");

    // pi quirk: an empty runtime override is skipped by getApiKey.
    both((auth) => auth.setRuntimeApiKey("groq", ""));
    await check("stored-key");

    both((auth) => auth.removeRuntimeApiKey("groq"));
    await check("stored-key");

    both((auth) => auth.remove("groq"));
    await check("env-key");

    vi.stubEnv("GROQ_API_KEY", undefined);
    await check("fallback-key", true);
  });

  it("runtime override beats an OAuth entry; hasAuth counts an empty override", async () => {
    const pair = makePair({
      auth: json({
        anthropic: { type: "oauth", refresh: "r", access: "oauth-access", expires: FUTURE },
      }),
    });
    for (const side of ["pi", "own"] as const) {
      pair[side].auth.setRuntimeApiKey("anthropic", "runtime-key");
      pair[side].auth.setRuntimeApiKey("bb-empty", "");
    }
    expect(await pair.own.auth.getApiKey("anthropic")).toBe("runtime-key");
    expect(pair.own.auth.hasAuth("bb-empty")).toBe(true);
    expect(await pair.own.auth.getApiKey("bb-empty")).toBeUndefined();
    await expectSameAuth(pair, ["anthropic", "bb-empty"]);
    await expectSameRegistry(pair);
  });

  it.skipIf(isWindows)(
    "stored api_key values: env name, cached command, failing command",
    async () => {
      vi.stubEnv("BB_MODELS_DIFF_STORED", "resolved-from-env");
      vi.stubEnv("GROQ_API_KEY", "env-key");
      const pair = makePair({
        auth: (dir) =>
          json({
            openai: { type: "api_key", key: "BB_MODELS_DIFF_STORED" },
            xai: { type: "api_key", key: `!echo run >> "${dir}/count"; echo cmd-key` },
            // A failing command yields nothing and does not fall through to the environment.
            groq: { type: "api_key", key: "!exit 2" },
          }),
      });
      expect(await pair.own.auth.getApiKey("openai")).toBe("resolved-from-env");
      expect(await pair.own.auth.getApiKey("xai")).toBe("cmd-key");
      expect(await pair.own.auth.getApiKey("groq")).toBeUndefined();
      await expectSameAuth(pair, ["openai", "xai", "groq"]);
      // Cached for the life of the process: one execution per implementation.
      for (const side of ["pi", "own"] as const) {
        await pair[side].auth.getApiKey("xai");
        expect(fs.readFileSync(path.join(pair[side].dir, "count"), "utf8")).toBe("run\n");
      }
      await expectSameRegistry(pair);
    },
  );

  it("set / remove write the same bytes, merging with what is on disk", async () => {
    const pair = makePair({ auth: json({ openai: { type: "api_key", key: "first" } }) });
    const data: AuthStorageData = {
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: FUTURE, extra: { n: 1 } },
    };
    for (const side of ["pi", "own"] as const) {
      const auth = pair[side].auth;
      auth.set("zai", { type: "api_key", key: 'k"quoted' });
      auth.set("anthropic", data.anthropic);
      // Another process adds an entry behind our back; the next write keeps it.
      const onDisk = JSON.parse(fs.readFileSync(pair[side].authPath, "utf8")) as AuthStorageData;
      onDisk.external = { type: "api_key", key: "from-other-process" };
      fs.writeFileSync(pair[side].authPath, JSON.stringify(onDisk));
      auth.remove("openai");
      auth.set("mistral", { type: "api_key", key: "m" });
    }
    const bytes = fs.readFileSync(pair.own.authPath, "utf8");
    // Every write ends with chmod 0600, even after another process rewrote the file.
    expect(fileMode(pair.own.authPath)).toBe(isWindows ? 0 : 0o600);
    expect(JSON.parse(bytes)).toStrictEqual({
      zai: { type: "api_key", key: 'k"quoted' },
      anthropic: data.anthropic,
      external: { type: "api_key", key: "from-other-process" },
      mistral: { type: "api_key", key: "m" },
    });
    expect(bytes.endsWith("}")).toBe(true);
    // In memory the external entry is unknown until reload().
    expect(pair.own.auth.has("external")).toBe(false);
    await expectSameAuth(pair, ["openai", "zai", "anthropic", "mistral", "external"]);
    for (const side of ["pi", "own"] as const) {
      pair[side].auth.reload();
    }
    expect(pair.own.auth.has("external")).toBe(true);
    await expectSameAuth(pair, ["openai", "zai", "anthropic", "mistral", "external"]);
    expect(expectSameDrainedErrors(pair)).toStrictEqual([]);
  });

  it("a corrupt auth.json is never overwritten; errors are drained once", async () => {
    const pair = makePair({ auth: "{ not json" });
    for (const side of ["pi", "own"] as const) {
      pair[side].auth.set("openai", { type: "api_key", key: "k" });
      pair[side].auth.remove("anthropic");
    }
    expect(fs.readFileSync(pair.own.authPath, "utf8")).toBe("{ not json");
    expect(pair.own.auth.get("openai")).toStrictEqual({ type: "api_key", key: "k" });
    await expectSameAuth(pair, ["openai", "anthropic"]);
    expect(expectSameDrainedErrors(pair)).toHaveLength(1);
    expect(expectSameDrainedErrors(pair)).toHaveLength(0);

    // Once the file is valid again, reload() re-enables writes.
    for (const side of ["pi", "own"] as const) {
      fs.writeFileSync(pair[side].authPath, json({ zai: { type: "api_key", key: "z" } }));
      pair[side].auth.reload();
      pair[side].auth.set("openai", { type: "api_key", key: "k2" });
    }
    expect(JSON.parse(fs.readFileSync(pair.own.authPath, "utf8"))).toStrictEqual({
      zai: { type: "api_key", key: "z" },
      openai: { type: "api_key", key: "k2" },
    });
    await expectSameAuth(pair, ["openai", "zai"]);
  });

  it("a lock held elsewhere: load fails after the retries and writes stay off until reload", async () => {
    const pair = makePair({ auth: json({ openai: { type: "api_key", key: "k" } }) });
    const fresh: Record<string, string[]> = {};
    for (const side of ["pi", "own"] as const) {
      const authPath = pair[side].authPath;
      const release = lockfile.lockSync(authPath, { realpath: false });
      try {
        // An instance created while the lock is held sees no credentials at all.
        const created =
          side === "pi" ? PiAuthStorage.create(authPath) : AuthStorage.create(authPath);
        fresh[side] = [
          JSON.stringify(created.list()),
          ...created.drainErrors().map((error) => error.message),
        ];
        // An existing instance keeps its data but stops persisting.
        pair[side].auth.reload();
        pair[side].auth.set("zai", { type: "api_key", key: "z" });
      } finally {
        release();
      }
    }
    expect(fresh.own).toStrictEqual(fresh.pi);
    expect(fresh.own).toStrictEqual(["[]", "Lock file is already being held"]);
    expect(pair.own.auth.list()).toStrictEqual(["openai", "zai"]);
    expect(JSON.parse(fs.readFileSync(pair.own.authPath, "utf8"))).toStrictEqual({
      openai: { type: "api_key", key: "k" },
    });
    await expectSameAuth(pair, ["openai", "zai"]);
    expect(expectSameDrainedErrors(pair)).toStrictEqual(["Lock file is already being held"]);

    for (const side of ["pi", "own"] as const) {
      pair[side].auth.reload();
      pair[side].auth.set("xai", { type: "api_key", key: "x" });
    }
    // The set() made while the load error was active is lost on reload.
    expect(JSON.parse(fs.readFileSync(pair.own.authPath, "utf8"))).toStrictEqual({
      openai: { type: "api_key", key: "k" },
      xai: { type: "api_key", key: "x" },
    });
    await expectSameAuth(pair, ["openai", "zai", "xai"]);
  });

  it("inMemory and fromStorage behave the same", async () => {
    const data: AuthStorageData = {
      openai: { type: "api_key", key: "k" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
    };
    const pi = PiAuthStorage.inMemory(data);
    const own = AuthStorage.inMemory(data);
    own.set("zai", { type: "api_key", key: "z" });
    pi.set("zai", { type: "api_key", key: "z" });
    own.remove("openai");
    pi.remove("openai");
    expect(own.list()).toStrictEqual(pi.list());
    expect(own.getAll()).toStrictEqual(pi.getAll());
    expect(await own.getApiKey("anthropic")).toBe(await pi.getApiKey("anthropic"));
    expect(await own.getApiKey("zai")).toBe("z");
    expect(AuthStorage.inMemory().list()).toStrictEqual(PiAuthStorage.inMemory().list());

    // A caller-supplied backend sees the same sequence of reads and writes.
    const makeBackend = () => {
      const log: Array<string | undefined> = [];
      let value: string | undefined = json({ openai: { type: "api_key", key: "k" } });
      const backend = {
        withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
          const { result, next } = fn(value);
          log.push(next);
          if (next !== undefined) {
            value = next;
          }
          return result;
        },
        async withLockAsync<T>(
          fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
        ): Promise<T> {
          const { result, next } = await fn(value);
          log.push(next);
          if (next !== undefined) {
            value = next;
          }
          return result;
        },
      };
      return { backend, log };
    };
    const piBackend = makeBackend();
    const ownBackend = makeBackend();
    const piStored = PiAuthStorage.fromStorage(piBackend.backend);
    const ownStored = AuthStorage.fromStorage(ownBackend.backend);
    for (const auth of [piStored, ownStored]) {
      auth.set("zai", { type: "api_key", key: "z" });
      auth.remove("openai");
      auth.reload();
    }
    expect(ownBackend.log).toStrictEqual(piBackend.log);
    expect(ownStored.list()).toStrictEqual(["zai"]);
  });
});

// ----------------------------------------------------------------------------
// OAuth refresh (no network: a fake provider in pi-ai's OAuth registry)
// ----------------------------------------------------------------------------

describe("AuthStorage OAuth refresh matches pi", () => {
  const OAUTH_ID = "bb-test-oauth";
  const FUTURE = 4102444800000;
  const EXPIRED = { type: "oauth", refresh: "r1", access: "a1", expires: 1 } as const;
  const REFRESHED: OAuthCredentials = {
    refresh: "r2",
    access: "a2",
    expires: FUTURE,
    account: "x",
  };

  function registerFakeProvider(
    refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>,
  ): { calls: OAuthCredentials[] } {
    const state = { calls: [] as OAuthCredentials[] };
    const provider: OAuthProviderInterface = {
      id: OAUTH_ID,
      name: "Fake OAuth",
      login: async () => {
        throw new Error("not used");
      },
      refreshToken: async (credentials) => {
        state.calls.push(credentials);
        return refreshToken(credentials);
      },
      getApiKey: (credentials) => `key:${credentials.access}`,
    };
    registerOAuthProvider(provider);
    return state;
  }

  it("refreshes an expired token once, stores it, and uses it afterwards", async () => {
    const state = registerFakeProvider(async () => REFRESHED);
    const pair = makePair({
      auth: json({ [OAUTH_ID]: EXPIRED, openai: { type: "api_key", key: "k" } }),
    });
    for (const side of ["pi", "own"] as const) {
      const before = state.calls.length;
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("key:a2");
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("key:a2");
      expect(state.calls.length - before).toBe(1);
      expect(state.calls.at(-1)).toStrictEqual(EXPIRED);
      expect(fs.existsSync(`${pair[side].authPath}.lock`)).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(pair.own.authPath, "utf8"))).toStrictEqual({
      [OAUTH_ID]: { type: "oauth", ...REFRESHED },
      openai: { type: "api_key", key: "k" },
    });
    expect(fileMode(pair.own.authPath)).toBe(isWindows ? 0 : 0o600);
    await expectSameAuth(pair, [OAUTH_ID, "openai"]);
    expect(expectSameDrainedErrors(pair)).toStrictEqual([]);
  });

  it("skips the refresh when another process already stored a fresh token", async () => {
    const state = registerFakeProvider(async () => REFRESHED);
    const pair = makePair({ auth: json({ [OAUTH_ID]: EXPIRED }) });
    const fresh = { type: "oauth", refresh: "r9", access: "a9", expires: FUTURE };
    for (const side of ["pi", "own"] as const) {
      // In memory the token is expired; on disk it has been replaced.
      fs.writeFileSync(
        pair[side].authPath,
        json({ [OAUTH_ID]: fresh, added: { type: "api_key", key: "n" } }),
      );
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("key:a9");
    }
    expect(state.calls).toHaveLength(0);
    // The re-read under the lock replaced the in-memory data.
    expect(pair.own.auth.has("added")).toBe(true);
    await expectSameAuth(pair, [OAUTH_ID, "added"]);
  });

  it("a failed refresh yields no key, keeps the credentials, and records the error", async () => {
    registerFakeProvider(async () => {
      throw new Error("network down: secret-detail");
    });
    const pair = makePair({ auth: json({ [OAUTH_ID]: EXPIRED }) });
    for (const side of ["pi", "own"] as const) {
      pair[side].auth.setFallbackResolver(() => "fallback-key");
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBeUndefined();
    }
    expect(JSON.parse(fs.readFileSync(pair.own.authPath, "utf8"))).toStrictEqual({
      [OAUTH_ID]: EXPIRED,
    });
    expect(readAuthFile(pair, "own")).toBe(readAuthFile(pair, "pi"));
    expect(expectSameDrainedErrors(pair)).toStrictEqual([
      `Failed to refresh OAuth token for ${OAUTH_ID}`,
    ]);
    // The registry reports this as "ok, no key", which pi's session turns into its auth error.
    const model = { ...UNKNOWN_MODEL, provider: OAUTH_ID };
    expect(await pair.own.registry.getApiKeyAndHeaders(model)).toStrictEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
    expect(pair.own.registry.isUsingOAuth(model)).toBe(true);
    await expectSameRequestAuth(pair, model, model);
  });

  it("a failed refresh still succeeds when the file holds a fresh token afterwards", async () => {
    const fresh = { type: "oauth", refresh: "r9", access: "a9", expires: FUTURE };
    let targetPath = "";
    registerFakeProvider(async () => {
      // Another process wins the race while our refresh fails.
      fs.writeFileSync(targetPath, json({ [OAUTH_ID]: fresh }));
      throw new Error("refresh token already used");
    });
    const pair = makePair({ auth: json({ [OAUTH_ID]: EXPIRED }) });
    for (const side of ["pi", "own"] as const) {
      targetPath = pair[side].authPath;
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("key:a9");
    }
    await expectSameAuth(pair, [OAUTH_ID]);
    expect(expectSameDrainedErrors(pair)).toHaveLength(1);
  });

  it("an expired entry that is gone from the file falls through to env and fallback", async () => {
    const state = registerFakeProvider(async () => REFRESHED);
    const pair = makePair({ auth: json({ [OAUTH_ID]: EXPIRED }) });
    for (const side of ["pi", "own"] as const) {
      pair[side].auth.setFallbackResolver(() => "fallback-key");
      fs.writeFileSync(
        pair[side].authPath,
        json({ [OAUTH_ID]: { type: "api_key", key: "now-a-key" } }),
      );
      // pi quirk: this call does not return the api_key that is now on disk.
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("fallback-key");
      expect(await pair[side].auth.getApiKey(OAUTH_ID)).toBe("now-a-key");
    }
    expect(state.calls).toHaveLength(0);
    await expectSameAuth(pair, [OAUTH_ID]);
  });

  it("two instances over one file refresh once (lock, then re-read)", async () => {
    const state = registerFakeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return REFRESHED;
    });
    const results: Record<
      string,
      { keys: Array<string | undefined>; calls: number; bytes: string }
    > = {};
    for (const side of ["pi", "own"] as const) {
      const dir = makeDir(`${side}-race`);
      const authPath = path.join(dir, "auth.json");
      fs.writeFileSync(authPath, json({ [OAUTH_ID]: EXPIRED }));
      const create = () =>
        side === "pi" ? PiAuthStorage.create(authPath) : AuthStorage.create(authPath);
      const a = create();
      const b = create();
      const before = state.calls.length;
      const keys = await Promise.all([a.getApiKey(OAUTH_ID), b.getApiKey(OAUTH_ID)]);
      results[side] = {
        keys,
        calls: state.calls.length - before,
        bytes: fs.readFileSync(authPath, "utf8"),
      };
      expect(fs.existsSync(`${authPath}.lock`)).toBe(false);
    }
    expect(results.own).toStrictEqual(results.pi);
    expect(results.own.keys).toStrictEqual(["key:a2", "key:a2"]);
    expect(results.own.calls).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// registerProvider / unregisterProvider / refresh
// ----------------------------------------------------------------------------

describe("ModelRegistry dynamic providers and refresh match pi", () => {
  const FUTURE = 4102444800000;
  const modelDef = (id: string) => ({
    id,
    name: id.toUpperCase(),
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });

  function both(pair: Pair, fn: (registry: PiModelRegistry | ModelRegistry) => void): void {
    fn(pair.pi.registry);
    fn(pair.own.registry);
  }

  it("validation errors", () => {
    const pair = makePair();
    const configs = [
      { streamSimple: () => createAssistantMessageEventStream() },
      { models: [modelDef("a")] },
      { baseUrl: "http://x", models: [modelDef("a")] },
      { baseUrl: "http://x", apiKey: "k", models: [modelDef("a")] },
    ];
    const messages = (registry: PiModelRegistry | ModelRegistry) =>
      configs.map((config) => {
        try {
          registry.registerProvider("dyn", config);
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      });
    const ownMessages = messages(pair.own.registry);
    expect(ownMessages).toStrictEqual(messages(pair.pi.registry));
    expect(ownMessages).toStrictEqual([
      'Provider dyn: "api" is required when registering streamSimple.',
      'Provider dyn: "baseUrl" is required when defining models.',
      'Provider dyn: "apiKey" or "oauth" is required when defining models.',
      'Provider dyn, model a: no "api" specified.',
    ]);
  });

  it("register with models, override-only, upsert, then unregister restores everything", async () => {
    const pair = makePair({
      models: json({
        providers: {
          mine: {
            baseUrl: "http://x",
            apiKey: "k",
            api: "openai-completions",
            models: [{ id: "m" }],
          },
        },
      }),
    });
    both(pair, (registry) =>
      registry.registerProvider("dyn", {
        baseUrl: "http://dyn/v1",
        apiKey: "dyn-key",
        api: "openai-completions",
        authHeader: true,
        headers: { "X-Dyn": "1" },
        models: [
          { ...modelDef("a"), headers: { "X-A": "a" } },
          { ...modelDef("b"), api: "openai-responses", baseUrl: "http://dyn/b" },
        ],
      }),
    );
    expect(pair.own.registry.find("dyn", "b")?.baseUrl).toBe("http://dyn/b");
    await expectSameRegistry(pair, [
      ["dyn", "a"],
      ["dyn", "b"],
      ["mine", "m"],
    ]);

    // Replacing the models of a provider that came from models.json, and of a built-in.
    both(pair, (registry) => {
      registry.registerProvider("mine", {
        baseUrl: "http://replaced",
        apiKey: "k2",
        api: "openai-completions",
        models: [modelDef("only")],
      });
      registry.registerProvider("openai", { baseUrl: "https://openai.proxy/v1" });
      registry.registerProvider("groq", { headers: { "X-Groq": "g" } });
      // Upsert: a second registration of "dyn" changes only what it defines.
      registry.registerProvider("dyn", { apiKey: "dyn-key-2" });
    });
    expect(pair.own.registry.find("mine", "m")).toBeUndefined();
    expect(pair.own.registry.find("openai", getModels("openai")[0].id)?.baseUrl).toBe(
      "https://openai.proxy/v1",
    );
    await expectSameRegistry(pair, [
      ["dyn", "a"],
      ["dyn", "b"],
      ["mine", "m"],
      ["mine", "only"],
    ]);

    both(pair, (registry) => {
      registry.unregisterProvider("never-registered");
      registry.unregisterProvider("openai");
      registry.unregisterProvider("mine");
    });
    expect(pair.own.registry.find("mine", "m")).toBeDefined();
    expect(pair.own.registry.find("openai", getModels("openai")[0].id)).toBe(
      getModels("openai")[0],
    );
    await expectSameRegistry(pair, [
      ["dyn", "a"],
      ["dyn", "b"],
      ["mine", "m"],
      ["mine", "only"],
    ]);
  });

  it("register with oauth (modifyModels, key from the OAuth credential) and streamSimple", async () => {
    const pair = makePair({
      auth: json({
        dyn: { type: "oauth", refresh: "r", access: "tok", expires: FUTURE, host: "h.example" },
      }),
    });
    const config = {
      baseUrl: "http://dyn/v1",
      api: "bb-diff-api" as Api,
      streamSimple: () => createAssistantMessageEventStream(),
      oauth: {
        name: "Dyn OAuth",
        login: async (): Promise<OAuthCredentials> => {
          throw new Error("not used");
        },
        refreshToken: async (credentials: OAuthCredentials) => credentials,
        getApiKey: (credentials: OAuthCredentials) => `dyn:${credentials.access}`,
        modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) =>
          models.map((m) =>
            m.provider === "dyn" ? { ...m, baseUrl: `https://${String(credentials.host)}` } : m,
          ),
      },
      models: [modelDef("a")],
    };
    both(pair, (registry) => registry.registerProvider("dyn", config));
    const model = pair.own.registry.find("dyn", "a") as Model<Api>;
    expect(model.baseUrl).toBe("https://h.example");
    expect(await pair.own.registry.getApiKeyAndHeaders(model)).toStrictEqual({
      ok: true,
      apiKey: "dyn:tok",
      headers: undefined,
    });
    expect(pair.own.auth.getOAuthProviders().map((p) => p.id)).toContain("dyn");
    await expectSameRegistry(pair, [["dyn", "a"]]);

    // refresh() re-applies registered providers after resetting pi-ai's registries.
    both(pair, (registry) => registry.refresh());
    expect(pair.own.registry.find("dyn", "a")?.baseUrl).toBe("https://h.example");
    await expectSameRegistry(pair, [["dyn", "a"]]);

    both(pair, (registry) => registry.unregisterProvider("dyn"));
    expect(pair.own.registry.find("dyn", "a")).toBeUndefined();
    expect(pair.own.auth.getOAuthProviders().map((p) => p.id)).not.toContain("dyn");
    await expectSameRegistry(pair, [["dyn", "a"]]);
  });

  it("refresh() picks up models.json edits and clears or sets the error", async () => {
    const pair = makePair({ models: "{ broken" });
    expect(pair.own.registry.getError()).toMatch(/^Failed to parse models\.json/);
    await expectSameRegistry(pair);

    for (const side of ["pi", "own"] as const) {
      fs.writeFileSync(
        pair[side].modelsPath,
        json({
          providers: {
            mine: {
              baseUrl: "http://x",
              apiKey: "k",
              api: "openai-completions",
              models: [{ id: "m" }],
            },
            anthropic: { headers: { "X-H": "h" } },
          },
        }),
      );
      pair[side].registry.refresh();
    }
    expect(pair.own.registry.getError()).toBeUndefined();
    expect(pair.own.registry.find("mine", "m")).toBeDefined();
    await expectSameRegistry(pair, [["mine", "m"]]);

    for (const side of ["pi", "own"] as const) {
      fs.writeFileSync(pair[side].modelsPath, json({ providers: { mine: {} } }));
      pair[side].registry.refresh();
    }
    expect(pair.own.registry.getError()).toMatch(
      /^Failed to load models\.json: Provider mine: must specify/,
    );
    expect(pair.own.registry.find("mine", "m")).toBeUndefined();
    // Request config of the previous load is gone too.
    await expectSameRegistry(pair, [["mine", "m"]]);

    for (const side of ["pi", "own"] as const) {
      fs.rmSync(pair[side].modelsPath);
      pair[side].registry.refresh();
    }
    expect(pair.own.registry.getError()).toBeUndefined();
    await expectSameRegistry(pair);
  });

  it("inMemory registries are equal", async () => {
    const piAuth = PiAuthStorage.inMemory({ openai: { type: "api_key", key: "k" } });
    const ownAuth = AuthStorage.inMemory({ openai: { type: "api_key", key: "k" } });
    const pi = PiModelRegistry.inMemory(piAuth);
    const own = ModelRegistry.inMemory(ownAuth);
    expect(own.getError()).toBe(pi.getError());
    expectSameModels(pi.getAll(), own.getAll());
    expectSameModels(pi.getAvailable(), own.getAvailable());
    expect(own.authStorage).toBe(ownAuth);
    const model = own.find("openai", getModels("openai")[0].id) as Model<Api>;
    expect(await own.getApiKeyAndHeaders(model)).toStrictEqual(await pi.getApiKeyAndHeaders(model));
  });
});

// ----------------------------------------------------------------------------
// Schema fuzz: every single-point mutation of a full config, plus random ones
// ----------------------------------------------------------------------------

describe("models.json schema errors match pi (mutation fuzz)", () => {
  const FULL_CONFIG = {
    providers: {
      "local-llm": {
        name: "Local",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local-key",
        api: "openai-completions",
        headers: { "X-Provider": "p" },
        authHeader: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "qwen",
          cacheControlFormat: "anthropic",
          openRouterRouting: {
            allow_fallbacks: true,
            data_collection: "deny",
            order: ["a"],
            sort: { by: "price", partition: null },
            max_price: { prompt: 1, completion: "2" },
            preferred_min_throughput: { p50: 1 },
            preferred_max_latency: 3,
          },
          vercelGatewayRouting: { only: ["x"], order: ["y"] },
        },
        models: [
          {
            id: "m1",
            name: "Model One",
            api: "openai-responses",
            baseUrl: "http://localhost:1/v1",
            reasoning: true,
            thinkingLevelMap: { off: null, low: "l", high: "h" },
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
            contextWindow: 1000,
            maxTokens: 100,
            headers: { "X-Model": "m" },
            compat: { sendSessionIdHeader: true },
          },
          { id: "m2" },
        ],
      },
      anthropic: {
        baseUrl: "https://proxy.example/anthropic",
        headers: { "X-Proxy": "1" },
        compat: { supportsEagerToolInputStreaming: true },
        modelOverrides: {
          [ANTHROPIC_ID]: {
            name: "Renamed",
            reasoning: false,
            thinkingLevelMap: { xhigh: null },
            input: ["text"],
            cost: { input: 9 },
            contextWindow: 5000,
            maxTokens: 50,
            headers: { "X-Override": "o" },
            compat: { supportsLongCacheRetention: true },
          },
        },
        models: [{ id: "custom-claude" }],
      },
    },
  };

  type JsonPath = Array<string | number>;
  const DELETE = Symbol("delete");
  const REPLACEMENTS: unknown[] = [
    null,
    0,
    -1,
    1.5,
    "",
    "x",
    true,
    [],
    {},
    ["x"],
    [1],
    { a: 1 },
    DELETE,
  ];

  function collectPaths(value: unknown, prefix: JsonPath, out: JsonPath[]): void {
    if (prefix.length > 0) {
      out.push(prefix);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectPaths(item, [...prefix, index], out));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        collectPaths(child, [...prefix, key], out);
      }
    }
  }

  function mutate(config: unknown, target: JsonPath, replacement: unknown): boolean {
    let node = config as Record<string | number, unknown>;
    for (const key of target.slice(0, -1)) {
      const next = node?.[key];
      if (typeof next !== "object" || next === null) {
        return false;
      }
      node = next as Record<string | number, unknown>;
    }
    const last = target.at(-1) as string | number;
    if (replacement === DELETE) {
      if (Array.isArray(node)) {
        node.splice(Number(last), 1);
      } else {
        delete node[last];
      }
    } else {
      // A fresh copy each time: a later mutation may write into it.
      node[last] = structuredClone(replacement);
    }
    return true;
  }

  // One shared models.json path, so error strings compare without normalizing.
  function loadBoth(content: string): { pi: PiModelRegistry; own: ModelRegistry } {
    const file = path.join(fuzzDir, "models.json");
    fs.writeFileSync(file, content);
    return {
      pi: PiModelRegistry.create(PiAuthStorage.inMemory(), file),
      own: ModelRegistry.create(AuthStorage.inMemory(), file),
    };
  }

  let fuzzDir = "";
  const PROBES: Array<[string, string]> = [
    ["local-llm", "m1"],
    ["local-llm", "m2"],
    ["anthropic", ANTHROPIC_ID],
    ["anthropic", "custom-claude"],
  ];

  async function compare(config: unknown, label: string): Promise<string | undefined> {
    const { pi, own } = loadBoth(JSON.stringify(config));
    expect(own.getError(), label).toBe(pi.getError());
    expectSameModels(pi.getAll(), own.getAll());
    for (const [provider, id] of PROBES) {
      const piModel = pi.find(provider, id);
      const ownModel = own.find(provider, id);
      expect(ownModel, label).toStrictEqual(piModel);
      if (piModel && ownModel) {
        expect(await own.getApiKeyAndHeaders(ownModel), label).toStrictEqual(
          await pi.getApiKeyAndHeaders(piModel),
        );
        expect(own.hasConfiguredAuth(ownModel), label).toBe(pi.hasConfiguredAuth(piModel));
      }
    }
    return own.getError();
  }

  it("the unmutated config is valid in both", async () => {
    fuzzDir = makeDir("fuzz");
    expect(await compare(FULL_CONFIG, "base")).toBeUndefined();
  });

  it("every single-point mutation gives the same error and models", async () => {
    fuzzDir = makeDir("fuzz");
    const paths: JsonPath[] = [];
    collectPaths(FULL_CONFIG, [], paths);
    expect(paths.length).toBeGreaterThan(80);
    const outcomes = { error: 0, valid: 0 };
    for (const target of paths) {
      for (const replacement of REPLACEMENTS) {
        const config = structuredClone(FULL_CONFIG);
        mutate(config, target, replacement);
        const label = `${target.join(".")} <- ${replacement === DELETE ? "DELETE" : JSON.stringify(replacement)}`;
        outcomes[(await compare(config, label)) ? "error" : "valid"]++;
      }
    }
    // Both branches are well exercised.
    expect(outcomes.error).toBeGreaterThan(300);
    expect(outcomes.valid).toBeGreaterThan(100);
  });

  it("random multi-point mutations give the same error (error cap, ordering)", async () => {
    fuzzDir = makeDir("fuzz");
    const paths: JsonPath[] = [];
    collectPaths(FULL_CONFIG, [], paths);
    // mulberry32, fixed seed: the run is reproducible.
    let seed = 0x52c0ffee;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    let manyErrors = 0;
    for (let round = 0; round < 600; round++) {
      const config = structuredClone(FULL_CONFIG);
      const count = 2 + Math.floor(random() * 9);
      const applied: string[] = [];
      for (let i = 0; i < count; i++) {
        const target = pick(paths);
        const replacement = pick(REPLACEMENTS);
        if (mutate(config, target, replacement)) {
          applied.push(
            `${target.join(".")}<-${replacement === DELETE ? "DELETE" : JSON.stringify(replacement)}`,
          );
        }
      }
      const error = await compare(config, `round ${round}: ${applied.join(" | ")}`);
      if (error && error.split("\n").filter((line) => line.startsWith("  - ")).length >= 8) {
        manyErrors++;
      }
    }
    // The 8-error cap is actually reached in a good share of rounds.
    expect(manyErrors).toBeGreaterThan(20);
  });
});
