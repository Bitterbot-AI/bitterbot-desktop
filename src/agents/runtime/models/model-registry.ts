/**
 * Model registry: built-in pi-ai catalog plus custom models and overrides from
 * models.json, and per-request auth resolution through AuthStorage.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono):
 * `src/core/model-registry.ts`. The built-in catalog (`getProviders`,
 * `getModels`), the API provider registry and the OAuth provider registry
 * stay in pi-ai.
 *
 * What is ported: `ModelRegistry` with `create`, `inMemory`, `refresh`,
 * `getError`, `getAll`, `getAvailable`, `find`, `hasConfiguredAuth`,
 * `getApiKeyAndHeaders`, `isUsingOAuth`, `registerProvider`,
 * `unregisterProvider`, the public `authStorage` field, `clearApiKeyCache`,
 * and the types `ResolvedRequestAuth` and `ProviderConfigInput`. models.json
 * loading (comment and trailing comma stripping, schema validation, the extra
 * `validateConfig` rules), merging with the built-in catalog (provider
 * `baseUrl`/`compat` overrides, per-model overrides, custom models replacing
 * a built-in with the same provider and id, OAuth `modifyModels`), and every
 * error string are unchanged.
 *
 * Differences from the original:
 * - `ModelRegistry.create(authStorage, modelsJsonPath)` requires the path. pi
 *   defaults to `~/.pi/agent/models.json`; this repo always passes its own.
 * - Schema validation is the local port in `models-json-schema.ts` (pi uses
 *   typebox 1.x, which this repo does not depend on). Error text is the same.
 * - `authStorage` is this repo's `AuthStorage` port.
 *
 * Not ported (reached only from pi's interactive TUI): `getProviderAuthStatus`,
 * `getProviderDisplayName`, `getApiKeyForProvider`.
 *
 * pi quirks kept:
 * - `getAll()` returns the internal array, not a copy; unmodified built-in
 *   models are pi-ai's own objects.
 * - `find()` returns undefined (not null) when there is no match.
 * - Custom models always get `headers: undefined`; provider and model headers
 *   are resolved per request in `getApiKeyAndHeaders`, where every header
 *   value goes through the same resolution as an API key (environment
 *   variable name, "!command", or literal) on every call, uncached.
 * - `hasConfiguredAuth` is true when models.json gives the provider an
 *   `apiKey`, without resolving it (a command that would fail still counts).
 * - `getApiKeyAndHeaders` returns `{ ok: true }` with `apiKey` undefined when
 *   nothing is configured; only `authHeader: true` turns a missing key into
 *   `{ ok: false }`.
 * - A models.json error keeps the built-in models and drops every custom
 *   model, override and request config from that file.
 * - `refresh()` and `unregisterProvider()` call pi-ai's `resetApiProviders()`
 *   and `resetOAuthProviders()`: every API or OAuth provider registered with
 *   pi-ai by anyone (not only through this registry) is dropped, and only
 *   the ones registered through `registerProvider` on this instance are
 *   re-applied.
 * - `registerProvider` on a provider with models replaces all of that
 *   provider's models and does not apply defaults (the caller gives full
 *   model definitions).
 *
 * Security: API keys and header values are returned to the caller and never
 * logged here. An error from a failed "!command" names the command text, not
 * its output.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  type AnthropicMessagesCompat,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  type OAuthProviderInterface,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  registerApiProvider,
  resetApiProviders,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import type { AuthStorage } from "./auth-storage.js";
import {
  type ModelOverride,
  type ModelsConfig,
  validateModelsConfig,
} from "./models-json-schema.js";
import {
  clearConfigValueCache,
  resolveConfigValueOrThrow,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (m: string, tail: string | undefined) => tail ?? (m[0] === '"' ? m : ""),
    );
}

/** Provider override config (baseUrl, compat) without request auth/headers. */
interface ProviderOverride {
  baseUrl?: string;
  compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

/** Result of loading custom models from models.json. */
interface CustomModelsResult {
  models: Model<Api>[];
  /** Providers with baseUrl/compat overrides for built-in models. */
  overrides: Map<string, ProviderOverride>;
  /** Per-model overrides: provider -> modelId -> override. */
  modelOverrides: Map<string, Map<string, ModelOverride>>;
  error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

type AnyCompat = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

function mergeCompat(
  baseCompat: Model<Api>["compat"],
  overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
  if (!overrideCompat) {
    return baseCompat;
  }

  const base = baseCompat as AnyCompat | undefined;
  const override = overrideCompat as AnyCompat;
  const merged = { ...base, ...override } as AnyCompat;

  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;

  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting,
    };
  }

  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting,
    };
  }

  return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
  const result = { ...model };

  // Simple field overrides.
  if (override.name !== undefined) {
    result.name = override.name;
  }
  if (override.reasoning !== undefined) {
    result.reasoning = override.reasoning;
  }
  if (override.thinkingLevelMap !== undefined) {
    result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
  }
  if (override.input !== undefined) {
    result.input = override.input;
  }
  if (override.contextWindow !== undefined) {
    result.contextWindow = override.contextWindow;
  }
  if (override.maxTokens !== undefined) {
    result.maxTokens = override.maxTokens;
  }

  // Merge cost (partial override).
  if (override.cost) {
    result.cost = {
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
    };
  }

  // Deep merge compat.
  result.compat = mergeCompat(model.compat, override.compat);

  return result;
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry: loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
  private models: Model<Api>[] = [];
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;

  private constructor(
    readonly authStorage: AuthStorage,
    private modelsJsonPath: string | undefined,
  ) {
    this.loadModels();
  }

  static create(authStorage: AuthStorage, modelsJsonPath: string): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /**
   * Reload models from disk (built-in + custom from models.json).
   */
  refresh(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    // Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
    resetApiProviders();
    resetOAuthProviders();

    this.loadModels();

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  /**
   * Get any error from loading models.json (undefined if no error).
   */
  getError(): string | undefined {
    return this.loadError;
  }

  private loadModels(): void {
    // Load custom models and overrides from models.json.
    const {
      models: customModels,
      overrides,
      modelOverrides,
      error,
    } = this.modelsJsonPath
      ? this.loadCustomModels(this.modelsJsonPath)
      : emptyCustomModelsResult();

    if (error) {
      this.loadError = error;
      // Keep built-in models even if custom models failed to load.
    }

    const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
    let combined = this.mergeCustomModels(builtInModels, customModels);

    // Let OAuth providers modify their models (e.g., update baseUrl).
    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }

    this.models = combined;
  }

  /** Load built-in models and apply provider/model overrides. */
  private loadBuiltInModels(
    overrides: Map<string, ProviderOverride>,
    modelOverrides: Map<string, Map<string, ModelOverride>>,
  ): Model<Api>[] {
    return getProviders().flatMap((provider) => {
      const models = getModels(provider as KnownProvider) as Model<Api>[];
      const providerOverride = overrides.get(provider);
      const perModelOverrides = modelOverrides.get(provider);

      return models.map((m) => {
        let model = m;

        // Apply provider-level baseUrl/compat override.
        if (providerOverride) {
          model = {
            ...model,
            baseUrl: providerOverride.baseUrl ?? model.baseUrl,
            compat: mergeCompat(model.compat, providerOverride.compat),
          };
        }

        // Apply per-model override.
        const modelOverride = perModelOverrides?.get(m.id);
        if (modelOverride) {
          model = applyModelOverride(model, modelOverride);
        }

        return model;
      });
    });
  }

  /** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
  private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
      const existingIndex = merged.findIndex(
        (m) => m.provider === customModel.provider && m.id === customModel.id,
      );
      if (existingIndex >= 0) {
        merged[existingIndex] = customModel;
      } else {
        merged.push(customModel);
      }
    }
    return merged;
  }

  private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
    if (!existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = readFileSync(modelsJsonPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(content)) as unknown;

      const validation = validateModelsConfig(parsed);
      if (!validation.ok) {
        return emptyCustomModelsResult(
          `Invalid models.json schema:\n${validation.errors}\n\nFile: ${modelsJsonPath}`,
        );
      }

      const config = validation.config;

      // Additional validation.
      this.validateConfig(config);

      const overrides = new Map<string, ProviderOverride>();
      const modelOverrides = new Map<string, Map<string, ModelOverride>>();

      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.baseUrl || providerConfig.compat) {
          overrides.set(providerName, {
            baseUrl: providerConfig.baseUrl,
            compat: providerConfig.compat,
          });
        }

        this.storeProviderRequestConfig(providerName, providerConfig);

        if (providerConfig.modelOverrides) {
          modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
          for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
            this.storeModelHeaders(providerName, modelId, modelOverride.headers);
          }
        }
      }

      return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return emptyCustomModelsResult(
          `Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`,
        );
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${modelsJsonPath}`,
      );
    }
  }

  private validateConfig(config: ModelsConfig): void {
    const builtInProviders = new Set<string>(getProviders());

    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const isBuiltIn = builtInProviders.has(providerName);
      const hasProviderApi = !!providerConfig.api;
      const models = providerConfig.models ?? [];
      const hasModelOverrides =
        providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

      if (models.length === 0) {
        // Override-only config: needs baseUrl, headers, compat, modelOverrides, or some combination.
        if (
          !providerConfig.baseUrl &&
          !providerConfig.headers &&
          !providerConfig.compat &&
          !hasModelOverrides
        ) {
          throw new Error(
            `Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
          );
        }
      } else if (!isBuiltIn) {
        // Non-built-in providers with custom models require endpoint + auth.
        if (!providerConfig.baseUrl) {
          throw new Error(
            `Provider ${providerName}: "baseUrl" is required when defining custom models.`,
          );
        }
        if (!providerConfig.apiKey) {
          throw new Error(
            `Provider ${providerName}: "apiKey" is required when defining custom models.`,
          );
        }
      }
      // Built-in providers with custom models: baseUrl/apiKey/api are optional,
      // inherited from built-in models. Auth comes from env vars / auth storage.

      for (const modelDef of models) {
        const hasModelApi = !!modelDef.api;

        if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
          );
        }
        // For built-in providers, api is optional: inherited from built-in models.

        if (!modelDef.id) {
          throw new Error(`Provider ${providerName}: model missing "id"`);
        }
        // Validate contextWindow/maxTokens only if provided (they have defaults).
        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        }
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
        }
      }
    }
  }

  private parseModels(config: ModelsConfig): Model<Api>[] {
    const models: Model<Api>[] = [];
    const builtInProviders = new Set<string>(getProviders());

    // Cache built-in defaults (api, baseUrl) per provider, extracted from first model.
    const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
    const getBuiltInDefaults = (
      providerName: string,
    ): { api: string; baseUrl: string } | undefined => {
      if (!builtInProviders.has(providerName)) {
        return undefined;
      }
      if (builtInDefaultsCache.has(providerName)) {
        return builtInDefaultsCache.get(providerName);
      }
      const builtIn = getModels(providerName as KnownProvider) as Model<Api>[];
      if (builtIn.length === 0) {
        return undefined;
      }
      const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
      builtInDefaultsCache.set(providerName, defaults);
      return defaults;
    };

    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) {
        continue; // Override-only, no custom models.
      }

      const builtInDefaults = getBuiltInDefaults(providerName);

      for (const modelDef of modelDefs) {
        const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
        if (!api) {
          continue;
        }

        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
        if (!baseUrl) {
          continue;
        }

        const compat = mergeCompat(providerConfig.compat, modelDef.compat);
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input ?? ["text"],
          cost: modelDef.cost ?? defaultCost,
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          headers: undefined,
          compat,
        } as Model<Api>);
      }
    }

    return models;
  }

  /**
   * Get all models (built-in + custom).
   * If models.json had errors, returns only built-in models.
   */
  getAll(): Model<Api>[] {
    return this.models;
  }

  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable(): Model<Api>[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  /**
   * Find a model by provider and ID.
   */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  /**
   * Whether any auth is configured for the model's provider. Does not resolve
   * or refresh anything.
   */
  hasConfiguredAuth(model: Model<Api>): boolean {
    return (
      this.authStorage.hasAuth(model.provider) ||
      this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
    );
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: {
      apiKey?: string;
      headers?: Record<string, string>;
      authHeader?: boolean;
    },
  ): void {
    if (!config.apiKey && !config.headers && !config.authHeader) {
      return;
    }

    this.providerRequestConfigs.set(providerName, {
      apiKey: config.apiKey,
      headers: config.headers,
      authHeader: config.authHeader,
    });
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ): void {
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  /**
   * Get API key and request headers for a model.
   */
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, {
        includeFallback: false,
      });
      const apiKey =
        apiKeyFromAuthStorage ??
        (providerConfig?.apiKey
          ? resolveConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);

      const providerHeaders = resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );

      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a model is using OAuth credentials (subscription).
   */
  isUsingOAuth(model: Model<Api>): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /**
   * Register a provider dynamically.
   *
   * If provider has models: replaces all existing models for this provider.
   * If provider has only baseUrl/headers: overrides existing models' URLs.
   * If provider has oauth: registers the OAuth provider with pi-ai.
   */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.upsertRegisteredProvider(providerName, config);
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk so that
   * built-in models overridden by this provider are restored to their original state.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) {
      return;
    }
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  /**
   * Upsert a provider config into registeredProviders.
   * If the provider is already registered, defined values in the incoming config
   * override existing ones; undefined values are preserved from the stored config.
   * If the provider is not registered, the incoming config is stored as-is.
   */
  private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
    const existing = this.registeredProviders.get(providerName);
    if (!existing) {
      this.registeredProviders.set(providerName, config);
      return;
    }
    for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
      if (config[k] !== undefined) {
        (existing as Record<string, unknown>)[k] = config[k];
      }
    }
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    if (!config.apiKey && !config.oauth) {
      throw new Error(
        `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`,
      );
    }

    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    // Register OAuth provider if provided.
    if (config.oauth) {
      // Ensure the OAuth provider ID matches the provider name.
      const oauthProvider: OAuthProviderInterface = {
        ...config.oauth,
        id: providerName,
      };
      registerOAuthProvider(oauthProvider);
    }

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) =>
            streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }

    this.storeProviderRequestConfig(providerName, config);

    if (config.models && config.models.length > 0) {
      // Full replacement: remove existing models for this provider.
      this.models = this.models.filter((m) => m.provider !== providerName);

      // Parse and add new models.
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        this.models.push({
          id: modelDef.id,
          name: modelDef.name,
          api: api as Api,
          provider: providerName,
          baseUrl: modelDef.baseUrl ?? config.baseUrl!,
          reasoning: modelDef.reasoning,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input,
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers: undefined,
          compat: modelDef.compat,
        } as Model<Api>);
      }

      // Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl).
      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    } else if (config.baseUrl || config.headers) {
      // Override-only: update baseUrl for existing models. Request headers are resolved per request.
      this.models = this.models.map((m) => {
        if (m.provider !== providerName) {
          return m;
        }
        return {
          ...m,
          baseUrl: config.baseUrl ?? m.baseUrl,
        };
      });
    }
  }
}

/**
 * Input type for the registerProvider API.
 */
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  /** OAuth provider registered with pi-ai under the provider name. */
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
  }>;
}
