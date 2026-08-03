import { type BitterbotConfig, loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBitterbotAgentDir } from "./agent-paths.js";
import { applyLiveDiscovery, type ProviderMeta } from "./model-live-discovery.js";
import { ensureBitterbotModelsJson } from "./models-config.js";

const log = createSubsystemLogger("agent/model-catalog");

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  baseUrl?: string;
  api?: string;
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery.js");
let importPiSdk = defaultImportPiSdk;

const CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

function applyOpenAICodexSparkFallback(models: ModelCatalogEntry[]): void {
  const hasSpark = models.some(
    (entry) =>
      entry.provider === CODEX_PROVIDER &&
      entry.id.toLowerCase() === OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
  );
  if (hasSpark) {
    return;
  }

  const baseModel = models.find(
    (entry) =>
      entry.provider === CODEX_PROVIDER && entry.id.toLowerCase() === OPENAI_CODEX_GPT53_MODEL_ID,
  );
  if (!baseModel) {
    return;
  }

  models.push({
    ...baseModel,
    id: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
    name: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
  });
}

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

export async function loadModelCatalog(params?: {
  config?: BitterbotConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) {
    return modelCatalogPromise;
  }

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureBitterbotModelsJson(cfg);
      await (
        await import("./pi-auth-json.js")
      ).ensurePiAuthJsonFromAuthProfiles(resolveBitterbotAgentDir());
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = resolveBitterbotAgentDir();
      const { join } = await import("node:path");
      const authStorage = new piSdk.AuthStorage(join(agentDir, "auth.json"));
      const registry = new piSdk.ModelRegistry(authStorage, join(agentDir, "models.json")) as
        | {
            getAll: () => Array<DiscoveredModel>;
          }
        | Array<DiscoveredModel>;
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      // provider -> {baseUrl, api} captured from the vendored catalog, so live
      // discovery knows where and how to probe each provider. First entry wins.
      const providerMeta = new Map<string, ProviderMeta>();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
          continue;
        }
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        if (!providerMeta.has(provider)) {
          providerMeta.set(provider, {
            baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
            api: typeof entry?.api === "string" ? entry.api : undefined,
          });
        }
        models.push({ id, name, provider, contextWindow, reasoning, input });
      }
      applyOpenAICodexSparkFallback(models);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
      }

      const discovered = await maybeApplyLiveDiscovery(models, providerMeta, cfg);
      return sortModels(discovered);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

// Live discovery talks to the network, so it is skipped under tests (mirrors
// the ollama/vllm/bedrock discovery gates) and can be turned off entirely via
// config. Any failure inside falls back to the vendored catalog unchanged.
async function maybeApplyLiveDiscovery(
  models: ModelCatalogEntry[],
  providerMeta: Map<string, ProviderMeta>,
  cfg: BitterbotConfig,
): Promise<ModelCatalogEntry[]> {
  if (models.length === 0) {
    return models;
  }
  const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
  if (isTest) {
    return models;
  }
  if (cfg.models?.liveDiscovery?.enabled === false) {
    return models;
  }
  try {
    const { resolveApiKeyForProvider } = await import("./model-auth.js");
    const agentDir = resolveBitterbotAgentDir();
    const merged = await applyLiveDiscovery({
      vendored: models,
      providerMeta,
      timeoutMs: cfg.models?.liveDiscovery?.timeoutMs,
      resolveKey: async (provider) => {
        try {
          return await resolveApiKeyForProvider({ provider, cfg, agentDir });
        } catch {
          return null;
        }
      },
      logWarn: (message) => log.warn(message),
    });
    // applyLiveDiscovery returns ModelCatalogEntry-compatible objects (it only
    // reads/writes id/name/provider/contextWindow/reasoning/input).
    return merged as ModelCatalogEntry[];
  } catch (error) {
    if (!hasLoggedModelCatalogError) {
      log.warn(`Live model discovery pass failed: ${String(error)}`);
    }
    return models;
  }
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
