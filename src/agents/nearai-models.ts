import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/nearai-models");

export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";
export const NEARAI_DEFAULT_MODEL_ID = "zai-org/GLM-5.1-FP8";
export const NEARAI_DEFAULT_MODEL_REF = `nearai/${NEARAI_DEFAULT_MODEL_ID}`;

const NEARAI_DEFAULT_CONTEXT_WINDOW = 128000;
const NEARAI_DEFAULT_MAX_TOKENS = 8192;

export const NEARAI_MODEL_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
} satisfies NonNullable<ModelDefinitionConfig["compat"]>;

// Fallback chat catalog generated from GET https://cloud-api.near.ai/v1/model/list on 2026-05-21.
// Runtime discovery uses the public model list endpoint whenever possible.
export const NEARAI_MODEL_CATALOG = [
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
  },
  {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 5 },
  },
  {
    id: "anthropic/claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 5 },
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0.3 },
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    reasoning: false,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0.1 },
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 1.25 },
  },
  {
    id: "google/gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    reasoning: false,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 8192,
    cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0.25 },
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
  },
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 0.13, output: 0.4, cacheRead: 0.026, cacheWrite: 0.13 },
  },
  {
    id: "openai/gpt-4.1",
    name: "OpenAI GPT-4.1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "OpenAI GPT-4.1 Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "OpenAI GPT-4.1 Nano",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  },
  {
    id: "openai/gpt-5",
    name: "OpenAI GPT-5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  },
  {
    id: "openai/gpt-5.1",
    name: "GPT-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 1.25 },
  },
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    input: ["text"],
    contextWindow: 1050000,
    maxTokens: 8192,
    cost: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 2.5 },
  },
  {
    id: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    input: ["text"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 0.75, output: 4.5, cacheRead: 0, cacheWrite: 0.75 },
  },
  {
    id: "openai/gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    reasoning: true,
    input: ["text"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 0.2, output: 1.25, cacheRead: 0, cacheWrite: 0.2 },
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 1050000,
    maxTokens: 8192,
    cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 5 },
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    reasoning: true,
    input: ["text"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0.25 },
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    reasoning: true,
    input: ["text"],
    contextWindow: 400000,
    maxTokens: 8192,
    cost: { input: 0.05, output: 0.4, cacheRead: 0, cacheWrite: 0.05 },
  },
  {
    id: "openai/o3",
    name: "OpenAI o3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
  },
  {
    id: "openai/o3-mini",
    name: "o3 Mini",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 1.1, output: 4.4, cacheRead: 0, cacheWrite: 1.1 },
  },
  {
    id: "openai/o4-mini",
    name: "OpenAI o4 Mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  },
  {
    id: "Qwen/Qwen3.5-122B-A10B",
    name: "Qwen3.5 122B A10B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.4, output: 3.2, cacheRead: 0.08, cacheWrite: 0.4 },
  },
  {
    id: "Qwen/Qwen3.6-35B-A3B-FP8",
    name: "Qwen 3.6 35B A3B FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 0.17, output: 1.1, cacheRead: 0.056, cacheWrite: 0.17 },
  },
  {
    id: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    name: "Qwen3-VL-30B-A3B-Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 8192,
    cost: { input: 0.15, output: 0.55, cacheRead: 0.03, cacheWrite: 0.15 },
  },
  {
    id: "zai-org/GLM-5.1-FP8",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 8192,
    cost: { input: 0.85, output: 3.3, cacheRead: 0.17, cacheWrite: 0.85 },
  },
] satisfies ModelDefinitionConfig[];

type NearAiPrice = {
  amount?: unknown;
  scale?: unknown;
};

type NearAiModelEntry = {
  modelId?: unknown;
  inputCostPerToken?: NearAiPrice;
  outputCostPerToken?: NearAiPrice;
  cacheReadCostPerToken?: NearAiPrice;
  metadata?: {
    contextLength?: unknown;
    modelDisplayName?: unknown;
    architecture?: {
      inputModalities?: unknown;
      outputModalities?: unknown;
    };
  };
};

type NearAiModelListResponse = {
  models?: NearAiModelEntry[];
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeModalities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function inputFromModalities(modalities: string[]): Array<"text" | "image"> {
  if (!modalities.includes("text")) {
    return [];
  }
  return modalities.includes("image") ? ["text", "image"] : ["text"];
}

function priceToCostPerMillion(price: NearAiPrice | undefined): number {
  const amount =
    typeof price?.amount === "number" && Number.isFinite(price.amount) ? price.amount : 0;
  const scale = typeof price?.scale === "number" && Number.isFinite(price.scale) ? price.scale : 9;
  if (amount === 0) {
    return 0;
  }
  return Number((amount * 10 ** (6 - scale)).toPrecision(8));
}

function inferReasoning(id: string, name: string): boolean {
  return /(^|[/\s._-])(o[134]|r1)(?=$|[/\s._-])|reason|thinking|glm|claude-opus|gpt-5/i.test(
    `${id} ${name}`,
  );
}

function displayNameFromModelId(id: string): string {
  const base = id.split("/").pop() ?? id;
  return base.replace(/[-_]/g, " ").replace(/\b(\w)/g, (char) => char.toUpperCase());
}

function shouldIncludeNearAiModel(params: {
  id: string;
  inputModalities: string[];
  outputModalities: string[];
}): boolean {
  if (!params.id || params.id === "openai/privacy-filter" || /reranker/i.test(params.id)) {
    return false;
  }
  return params.inputModalities.includes("text") && params.outputModalities.includes("text");
}

export function mergeNearAiCompat(
  compat?: ModelDefinitionConfig["compat"],
): NonNullable<ModelDefinitionConfig["compat"]> {
  return {
    ...compat,
    ...NEARAI_MODEL_COMPAT,
  };
}

export function buildNearAiModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...entry,
    input: [...entry.input],
    cost: { ...entry.cost },
    compat: mergeNearAiCompat(entry.compat),
  };
}

function buildNearAiModelDefinitionFromApi(entry: NearAiModelEntry): ModelDefinitionConfig | null {
  const id = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
  const metadata = entry.metadata ?? {};
  const architecture = metadata.architecture ?? {};
  const inputModalities = normalizeModalities(architecture.inputModalities);
  const outputModalities = normalizeModalities(architecture.outputModalities);
  if (!shouldIncludeNearAiModel({ id, inputModalities, outputModalities })) {
    return null;
  }

  const name =
    typeof metadata.modelDisplayName === "string" && metadata.modelDisplayName.trim()
      ? metadata.modelDisplayName.trim()
      : displayNameFromModelId(id);
  const contextWindow = isPositiveNumber(metadata.contextLength)
    ? metadata.contextLength
    : NEARAI_DEFAULT_CONTEXT_WINDOW;
  const input = inputFromModalities(inputModalities);
  if (input.length === 0) {
    return null;
  }
  const inputCost = priceToCostPerMillion(entry.inputCostPerToken);

  return {
    id,
    name,
    reasoning: inferReasoning(id, name),
    input,
    cost: {
      input: inputCost,
      output: priceToCostPerMillion(entry.outputCostPerToken),
      cacheRead: priceToCostPerMillion(entry.cacheReadCostPerToken),
      cacheWrite: inputCost,
    },
    contextWindow,
    maxTokens: Math.min(NEARAI_DEFAULT_MAX_TOKENS, contextWindow),
    compat: mergeNearAiCompat(),
  };
}

export async function discoverNearAiModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return NEARAI_MODEL_CATALOG.map(buildNearAiModelDefinition);
  }

  try {
    const response = await fetch(`${NEARAI_BASE_URL}/model/list`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return NEARAI_MODEL_CATALOG.map(buildNearAiModelDefinition);
    }

    const body = (await response.json()) as NearAiModelListResponse;
    const entries = Array.isArray(body.models) ? body.models : [];
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];
    for (const entry of entries) {
      const model = buildNearAiModelDefinitionFromApi(entry);
      if (!model || seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      models.push(model);
    }

    return models.length > 0 ? models : NEARAI_MODEL_CATALOG.map(buildNearAiModelDefinition);
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return NEARAI_MODEL_CATALOG.map(buildNearAiModelDefinition);
  }
}
