import os from "node:os";
import path from "node:path";
import type { BitterbotConfig, MemorySearchConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_RRF_WEIGHTS, type HybridRrfWeights } from "../memory/hybrid.js";
import { DEFAULT_RRF_K } from "../memory/rrf.js";
import { clampInt, clampNumber, resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

const log = createSubsystemLogger("memory-search/config");

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions" | "skills">;
  extraPaths: string[];
  /** Workspace-relative glob patterns excluded from memory-file sync. */
  excludePaths: string[];
  provider: "openai" | "local" | "gemini" | "voyage" | "auto";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: {
    sessionMemory: boolean;
  };
  fallback: "openai" | "gemini" | "local" | "voyage" | "none";
  model: string;
  local: {
    modelPath?: string;
    modelCacheDir?: string;
    autoDownload?: boolean;
  };
  store: {
    driver: "sqlite";
    path: string;
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    importanceWeight: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mergeStrategy: "rrf" | "weighted";
      /** Per-channel RRF weights (`weight / (k + rank)`); 1/1/1 is unweighted. */
      rrfWeights: HybridRrfWeights;
      /** RRF smoothing constant k (default 60). */
      rrfK: number;
    };
    /** PLAN-58: per-channel detail the memory_search tool shows the model. */
    channelDiagnostics: "full" | "ranks" | "off";
    recency: {
      enabled: boolean;
      alpha: number;
      halfLifeHours: number;
    };
    /** How much of the post-fusion boosts (recency, emotional, mood, temporal) reaches an RRF score; 1 = full, 0 = none. */
    postFusionBoostScale: number;
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_VOYAGE_MODEL = "voyage-4-large";
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_IMPORTANCE_WEIGHT = 0.15;
const DEFAULT_HYBRID_MERGE_STRATEGY: "rrf" | "weighted" = "rrf";
// RRF channel weights. 1/1/1 at k 60 is plain unweighted RRF, the fusion that
// has always shipped, and it stays the default. The 2026-10-29 sweep on 318
// generated questions found vector 0.1 / keyword 1 far better (qualification
// MRR 0.238 -> 0.406), but on the 68 real journal queries no keyword-heavy
// setting was better than 1/1/1 (0.25: MRR 0.402 vs 0.400, hit@5 identical),
// so the gain did not transfer and there is no measured benefit to pay the
// comparability cost for. 0.25 and 0.1 are non-inferior on real queries and
// available as configuration; a LongMemEval-S retrieval check at 0.25 is the
// precondition for any future default change. See
// docs/research/fusion-weights-2026-10-29.md.
const DEFAULT_HYBRID_RRF_WEIGHTS: HybridRrfWeights = { ...DEFAULT_RRF_WEIGHTS };
const DEFAULT_HYBRID_RRF_K = DEFAULT_RRF_K;
const DEFAULT_RECENCY_ENABLED = true;
const DEFAULT_RECENCY_ALPHA = 0.5;
const DEFAULT_RECENCY_HALF_LIFE_HOURS = 48;
// Chosen on the 2026-10-27 live-memory held-out set (60 questions, one node):
// fused MRR 0.063 at 1 (legacy), 0.241 at 0.25, 0.276 at 0.1, 0.336 at 0.
// 0.1 keeps the designed recency / temporal preference as a tie-breaker and
// takes most of the gain; 0 is the measured optimum if an operator wants it.
// See boundPostFusionBoost in src/memory/hybrid.ts.
const DEFAULT_POST_FUSION_BOOST_SCALE = 0.1;
const DEFAULT_CACHE_ENABLED = true;
// Memory audit 2026-09-07 P1.4: the embedding cache had no default cap, so
// pruneEmbeddingCacheIfNeeded early-returned and the cache grew forever (it
// held 13,043 vectors as ~385 MB of JSON on the reference node, more than the
// live chunk count). Bound it by default; oldest (updated_at ASC) evicted.
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_SOURCES: Array<"memory" | "sessions" | "skills"> = ["memory", "sessions"];
// Token-efficiency pass (2026-09-19): the dream journal (429 KB, appended
// every cycle) and the per-cycle working-memory snapshots were re-chunked
// and re-embedded on every sync (60-180 s embed calls). Neither is user
// memory: insights are promoted as chunks separately, and snapshots are
// provenance for the rewrite. Override via memorySearch.excludePaths.
export const DEFAULT_MEMORY_EXCLUDE_PATHS = [
  "memory/memory-snapshots/**",
  "memory/dream-journal.md",
];

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") {
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * True when a workspace-relative path (forward slashes) matches one of the
 * exclusion globs. `**` spans directories, `*` a single segment.
 */
export function isExcludedMemoryPath(relPath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.?\//, "");
  return patterns.some((p) => globToRegExp(p.replaceAll("\\", "/")).test(normalized));
}

function normalizeSources(
  sources: Array<"memory" | "sessions" | "skills"> | undefined,
  sessionMemoryEnabled: boolean,
  skillsEnabled: boolean,
): Array<"memory" | "sessions" | "skills"> {
  const normalized = new Set<"memory" | "sessions" | "skills">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") {
      normalized.add("memory");
    }
    if (source === "sessions" && sessionMemoryEnabled) {
      normalized.add("sessions");
    }
    if (source === "skills") {
      normalized.add("skills");
    }
  }
  if (skillsEnabled && !normalized.has("skills")) {
    normalized.add("skills");
  }
  if (normalized.size === 0) {
    normalized.add("memory");
  }
  return Array.from(normalized);
}

function resolveStorePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  if (!raw) {
    return fallback;
  }
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}

function mergeConfig(
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
  agentId: string,
): ResolvedMemorySearchConfig {
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  const sessionMemory =
    overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? true;
  const provider = overrides?.provider ?? defaults?.provider ?? "auto";
  const defaultRemote = defaults?.remote;
  const overrideRemote = overrides?.remote;
  const hasRemoteConfig = Boolean(
    overrideRemote?.baseUrl ||
    overrideRemote?.apiKey ||
    overrideRemote?.headers ||
    defaultRemote?.baseUrl ||
    defaultRemote?.apiKey ||
    defaultRemote?.headers,
  );
  const includeRemote =
    hasRemoteConfig ||
    provider === "openai" ||
    provider === "gemini" ||
    provider === "voyage" ||
    provider === "auto";
  const batch = {
    enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
    wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
    concurrency: Math.max(
      1,
      overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2,
    ),
    pollIntervalMs:
      overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2000,
    timeoutMinutes:
      overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
        apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
        headers: overrideRemote?.headers ?? defaultRemote?.headers,
        batch,
      }
    : undefined;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
  const modelDefault =
    provider === "gemini"
      ? DEFAULT_GEMINI_MODEL
      : provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : provider === "voyage"
          ? DEFAULT_VOYAGE_MODEL
          : undefined;
  const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
  const local = {
    modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
    modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir,
    autoDownload: overrides?.local?.autoDownload ?? defaults?.local?.autoDownload,
  };
  const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory, false);
  const rawPaths = [...(defaults?.extraPaths ?? []), ...(overrides?.extraPaths ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const extraPaths = Array.from(new Set(rawPaths));
  const excludePaths = Array.from(
    new Set(
      (overrides?.excludePaths ?? defaults?.excludePaths ?? DEFAULT_MEMORY_EXCLUDE_PATHS)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  const vector = {
    enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
    extensionPath:
      overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath,
  };
  const store = {
    driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
    path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
    vector,
  };
  const chunking = {
    tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP,
  };
  const sync = {
    onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
    onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
    watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
    watchDebounceMs:
      overrides?.sync?.watchDebounceMs ??
      defaults?.sync?.watchDebounceMs ??
      DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 5,
    sessions: {
      deltaBytes:
        overrides?.sync?.sessions?.deltaBytes ??
        defaults?.sync?.sessions?.deltaBytes ??
        DEFAULT_SESSION_DELTA_BYTES,
      deltaMessages:
        overrides?.sync?.sessions?.deltaMessages ??
        defaults?.sync?.sessions?.deltaMessages ??
        DEFAULT_SESSION_DELTA_MESSAGES,
    },
  };
  const query = {
    maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE,
  };
  const hybrid = {
    enabled:
      overrides?.query?.hybrid?.enabled ??
      defaults?.query?.hybrid?.enabled ??
      DEFAULT_HYBRID_ENABLED,
    vectorWeight:
      overrides?.query?.hybrid?.vectorWeight ??
      defaults?.query?.hybrid?.vectorWeight ??
      DEFAULT_HYBRID_VECTOR_WEIGHT,
    textWeight:
      overrides?.query?.hybrid?.textWeight ??
      defaults?.query?.hybrid?.textWeight ??
      DEFAULT_HYBRID_TEXT_WEIGHT,
    candidateMultiplier:
      overrides?.query?.hybrid?.candidateMultiplier ??
      defaults?.query?.hybrid?.candidateMultiplier ??
      DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
    mergeStrategy:
      (overrides?.query?.hybrid as Record<string, unknown>)?.mergeStrategy ??
      (defaults?.query?.hybrid as Record<string, unknown>)?.mergeStrategy ??
      DEFAULT_HYBRID_MERGE_STRATEGY,
    rrfWeights: resolveRrfWeights(
      overrides?.query?.hybrid?.rrfWeights,
      defaults?.query?.hybrid?.rrfWeights,
    ),
    rrfK: resolveRrfK(overrides?.query?.hybrid?.rrfK ?? defaults?.query?.hybrid?.rrfK),
  };
  const cache = {
    enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries:
      overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
  };

  const importanceWeight = clampNumber(
    overrides?.query?.importanceWeight ??
      defaults?.query?.importanceWeight ??
      DEFAULT_IMPORTANCE_WEIGHT,
    0,
    1,
  );
  const overlap = clampNumber(chunking.overlap, 0, Math.max(0, chunking.tokens - 1));
  const minScore = clampNumber(query.minScore, 0, 1);
  const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
  const textWeight = clampNumber(hybrid.textWeight, 0, 1);
  const sum = vectorWeight + textWeight;
  const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
  const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
  const deltaBytes = clampInt(sync.sessions.deltaBytes, 0, Number.MAX_SAFE_INTEGER);
  const deltaMessages = clampInt(sync.sessions.deltaMessages, 0, Number.MAX_SAFE_INTEGER);
  return {
    enabled,
    sources,
    extraPaths,
    excludePaths,
    provider,
    remote,
    experimental: {
      sessionMemory,
    },
    fallback,
    model,
    local,
    store,
    chunking: { tokens: Math.max(1, chunking.tokens), overlap },
    sync: {
      ...sync,
      sessions: {
        deltaBytes,
        deltaMessages,
      },
    },
    query: {
      ...query,
      minScore,
      importanceWeight,
      hybrid: {
        enabled: Boolean(hybrid.enabled),
        vectorWeight: normalizedVectorWeight,
        textWeight: normalizedTextWeight,
        candidateMultiplier,
        mergeStrategy: hybrid.mergeStrategy as "rrf" | "weighted",
        rrfWeights: hybrid.rrfWeights,
        rrfK: hybrid.rrfK,
      },
      channelDiagnostics: resolveChannelDiagnostics(
        overrides?.query?.channelDiagnostics ?? defaults?.query?.channelDiagnostics,
      ),
      recency: {
        enabled:
          (overrides?.query as Record<string, unknown>)?.recency != null
            ? ((((overrides?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
                ?.enabled as boolean) ?? DEFAULT_RECENCY_ENABLED)
            : (defaults?.query as Record<string, unknown>)?.recency != null
              ? ((((defaults?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
                  ?.enabled as boolean) ?? DEFAULT_RECENCY_ENABLED)
              : DEFAULT_RECENCY_ENABLED,
        alpha: clampNumber(
          (((overrides?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
            ?.alpha as number) ??
            (((defaults?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
              ?.alpha as number) ??
            DEFAULT_RECENCY_ALPHA,
          0,
          1,
        ),
        halfLifeHours: Math.max(
          0.1,
          (((overrides?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
            ?.halfLifeHours as number) ??
            (((defaults?.query as Record<string, unknown>)?.recency as Record<string, unknown>)
              ?.halfLifeHours as number) ??
            DEFAULT_RECENCY_HALF_LIFE_HOURS,
        ),
      },
      postFusionBoostScale: clampNumber(
        ((overrides?.query as Record<string, unknown>)?.postFusionBoostScale as number) ??
          ((defaults?.query as Record<string, unknown>)?.postFusionBoostScale as number) ??
          DEFAULT_POST_FUSION_BOOST_SCALE,
        0,
        1,
      ),
    },
    cache: {
      enabled: Boolean(cache.enabled),
      maxEntries:
        typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries)
          ? Math.max(1, Math.floor(cache.maxEntries))
          : undefined,
    },
  };
}

/** Render a rejected config value for a warning (numbers as written, else JSON). */
const describeValue = (raw: unknown): string =>
  typeof raw === "number" ? String(raw) : JSON.stringify(raw);

/**
 * Per-channel RRF weights. Each channel is read from the override then the
 * default; a negative or non-finite value falls back to that channel's
 * default with a warning rather than failing the whole config.
 */
export function resolveRrfWeights(
  overrides: Partial<Record<keyof HybridRrfWeights, unknown>> | undefined,
  defaults: Partial<Record<keyof HybridRrfWeights, unknown>> | undefined,
  warn: (message: string) => void = (m) => log.warn(m),
): HybridRrfWeights {
  const out: HybridRrfWeights = { ...DEFAULT_HYBRID_RRF_WEIGHTS };
  for (const channel of Object.keys(out) as Array<keyof HybridRrfWeights>) {
    const raw = overrides?.[channel] ?? defaults?.[channel];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      out[channel] = raw;
    } else {
      warn(
        `memorySearch.query.hybrid.rrfWeights.${channel}=${describeValue(raw)} is not a finite number >= 0; using ${out[channel]}`,
      );
    }
  }
  return out;
}

/** RRF constant k: a positive finite number, else the default (60) with a warning. */
export function resolveRrfK(
  raw: unknown,
  warn: (message: string) => void = (m) => log.warn(m),
): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_HYBRID_RRF_K;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  warn(
    `memorySearch.query.hybrid.rrfK=${describeValue(raw)} is not a finite number > 0; using ${DEFAULT_HYBRID_RRF_K}`,
  );
  return DEFAULT_HYBRID_RRF_K;
}

/** PLAN-58: default "ranks"; anything unrecognised falls back to the default. */
export function resolveChannelDiagnostics(value: unknown): "full" | "ranks" | "off" {
  return value === "full" || value === "off" ? value : "ranks";
}

export function resolveMemorySearchConfig(
  cfg: BitterbotConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  // PLAN-45 5.1: a measurement process (the ablation harness) must never
  // instantiate the memory manager, whatever config a prompt block loads.
  if (process.env.BITTERBOT_MEMORY_OFF === "1") {
    return null;
  }
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) {
    return null;
  }
  // Auto-include "skills" source when skills config exists
  if (cfg.skills && !resolved.sources.includes("skills")) {
    resolved.sources.push("skills");
  }
  return resolved;
}
