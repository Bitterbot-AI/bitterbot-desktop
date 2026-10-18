/**
 * PLAN-57 §4.6: the embedding profile.
 *
 * Vectors from different models, or from the same model under different
 * preprocessing, must never share an index. The profile is the exact key:
 * provider, model, the model's content digest when it can be known,
 * dimensions once a vector has been seen, normalisation, truncation and the
 * chunking rules. It is recorded on the index (in the index meta) and
 * compared on every sync. A pool worker is eligible for a batch only when
 * the profile it reports back equals the local one.
 *
 * Two kinds of difference are treated differently on purpose:
 *
 * - `model`: provider or model id changed. The manager already handles this
 *   with an automatic safe reindex (new database, carry-over, swap) and keeps
 *   doing so; nothing here changes that path.
 * - `parity`: same provider and model, but the digest, dimensions,
 *   normalisation, truncation or chunker version differ. That is an Ollama
 *   tag pulled under the same name, a GGUF replaced in place, or a code
 *   change to the chunker. The index goes on hold: no new vector is written
 *   until the owner runs `bitterbot memory migrate-embeddings`, which rebuilds
 *   under the new profile. Silent mixing is the one thing that never happens.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/embedding-profile");

/** Bump when the chunker changes boundaries for the same `chunking` settings. */
export const CHUNKER_VERSION = 1;

export type EmbeddingNormalisation = "l2" | "provider";

export type EmbeddingProfile = {
  provider: string;
  model: string;
  /**
   * Content digest of the model weights: `sha256:<hex>` of a GGUF file, or
   * the Ollama manifest digest. Remote APIs have none, and `undefined` never
   * conflicts with anything.
   */
  modelDigest?: string;
  /** Fingerprint of what the digest was computed from (path, size, mtime), so it is not recomputed each boot. */
  digestFingerprint?: string;
  /** Known once a vector has been produced under this profile. */
  dimensions?: number;
  /** `l2`: Bitterbot normalises vectors before storing them (local GGUF). `provider`: stored as returned. */
  normalise: EmbeddingNormalisation;
  /**
   * `client`: inputs are pre-fitted to the model's token budget before they
   * are sent and no provider is asked to truncate (every current provider).
   * `provider`: the provider truncates; vectors of long inputs differ.
   */
  truncation: "client" | "provider";
  chunking: { tokens: number; overlap: number };
  chunkerVersion: number;
};

export function buildEmbeddingProfile(params: {
  provider: string;
  model: string;
  chunking: { tokens: number; overlap: number };
  modelDigest?: string;
  digestFingerprint?: string;
  dimensions?: number;
}): EmbeddingProfile {
  return {
    provider: params.provider,
    model: params.model,
    ...(params.modelDigest ? { modelDigest: params.modelDigest } : {}),
    ...(params.digestFingerprint ? { digestFingerprint: params.digestFingerprint } : {}),
    ...(params.dimensions && params.dimensions > 0 ? { dimensions: params.dimensions } : {}),
    normalise: params.provider === "local" ? "l2" : "provider",
    truncation: "client",
    chunking: { tokens: params.chunking.tokens, overlap: params.chunking.overlap },
    chunkerVersion: CHUNKER_VERSION,
  };
}

/** A stable string for ledger rows and logs. Unknown digest and dimensions print as `?`. */
export function embeddingProfileKey(p: EmbeddingProfile): string {
  return [
    p.provider,
    p.model,
    p.modelDigest ?? "?",
    p.dimensions ?? "?",
    p.normalise,
    p.truncation,
    `${p.chunking.tokens}/${p.chunking.overlap}`,
    `c${p.chunkerVersion}`,
  ].join("|");
}

export type ProfileComparison =
  | { same: true }
  | { same: false; kind: "model" | "parity"; conflicts: string[] };

/**
 * Compare the profile stored on an index with the one the running provider
 * has. Fields unknown on either side (digest, dimensions) never conflict.
 */
export function compareEmbeddingProfiles(
  stored: EmbeddingProfile | null | undefined,
  current: EmbeddingProfile,
): ProfileComparison {
  if (!stored) {
    return { same: true };
  }
  if (stored.provider !== current.provider || stored.model !== current.model) {
    return {
      same: false,
      kind: "model",
      conflicts: [`${stored.provider}/${stored.model} -> ${current.provider}/${current.model}`],
    };
  }
  const conflicts: string[] = [];
  if (stored.modelDigest && current.modelDigest && stored.modelDigest !== current.modelDigest) {
    conflicts.push(`model digest ${short(stored.modelDigest)} -> ${short(current.modelDigest)}`);
  }
  if (stored.dimensions && current.dimensions && stored.dimensions !== current.dimensions) {
    conflicts.push(`dimensions ${stored.dimensions} -> ${current.dimensions}`);
  }
  if (stored.normalise !== current.normalise) {
    conflicts.push(`normalisation ${stored.normalise} -> ${current.normalise}`);
  }
  if (stored.truncation !== current.truncation) {
    conflicts.push(`truncation ${stored.truncation} -> ${current.truncation}`);
  }
  if ((stored.chunkerVersion ?? 1) !== current.chunkerVersion) {
    conflicts.push(`chunker v${stored.chunkerVersion ?? 1} -> v${current.chunkerVersion}`);
  }
  return conflicts.length === 0 ? { same: true } : { same: false, kind: "parity", conflicts };
}

function short(digest: string): string {
  const hex = digest.replace(/^sha256:/, "");
  return hex.length > 12 ? `${hex.slice(0, 12)}…` : hex;
}

// ── digests ──

export type ResolvedDigest = { digest: string; fingerprint?: string };

/** The provider-side hook: a provider that can name its weights implements this. */
export type DigestResolver = (hint?: {
  fingerprint?: string;
  digest?: string;
}) => Promise<ResolvedDigest | undefined>;

/** `sha256:<hex>` of a file, streamed. Skipped when the hint's fingerprint still matches. */
export async function digestOfFile(
  filePath: string,
  hint?: { fingerprint?: string; digest?: string },
): Promise<ResolvedDigest | undefined> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const fingerprint = `${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
  if (hint?.digest && hint.fingerprint === fingerprint) {
    return { digest: hint.digest, fingerprint };
  }
  const started = Date.now();
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  const digest = `sha256:${hash.digest("hex")}`;
  log.info("embedding model digest computed", {
    file: filePath,
    bytes: stat.size,
    ms: Date.now() - started,
  });
  return { digest, fingerprint };
}

/**
 * The Ollama manifest digest for a model name, from `GET /api/tags` on the
 * same origin as an OpenAI-compatible base URL (`http://host:11434/v1`).
 * Names match with or without `:latest`. Any failure yields `undefined`.
 */
export async function digestFromOllama(params: {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResolvedDigest | undefined> {
  let origin: string;
  try {
    origin = new URL(params.baseUrl).origin;
  } catch {
    return undefined;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 3000);
  try {
    const res = await fetchImpl(`${origin}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as { models?: Array<{ name?: string; digest?: string }> };
    const want = new Set([
      params.model,
      params.model.replace(/:latest$/, ""),
      `${params.model}:latest`,
    ]);
    for (const m of body.models ?? []) {
      if (m.name && m.digest && want.has(m.name)) {
        return {
          digest: m.digest.startsWith("sha256:") ? m.digest : `sha256:${m.digest}`,
          fingerprint: `ollama|${origin}|${m.name}`,
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── pool parity ──

export type PoolExecutionProfile = {
  model?: string;
  modelDigest?: string;
  dimensions?: number;
  /** Reported by newer workers; absent means the Soapbox contract (`truncate:false`, raw vectors). */
  truncation?: "client" | "provider";
  normalise?: EmbeddingNormalisation;
};

/** Read the `execution` evidence a Soapbox embeddings result carries. Tolerant of absent fields, never throws. */
export function poolProfileFromExecution(execution: unknown): PoolExecutionProfile {
  if (!execution || typeof execution !== "object") {
    return {};
  }
  const e = execution as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const digest = str(e.model_digest) ?? str(e.modelDigest);
  const dims = typeof e.dimensions === "number" && e.dimensions > 0 ? e.dimensions : undefined;
  const truncate = e.truncate ?? e.truncation;
  return {
    model: str(e.model),
    modelDigest: digest ? (digest.startsWith("sha256:") ? digest : `sha256:${digest}`) : undefined,
    dimensions: dims,
    truncation:
      truncate === false || truncate === "client"
        ? "client"
        : truncate === true || truncate === "provider"
          ? "provider"
          : undefined,
    normalise:
      e.normalize === "l2" || e.normalise === "l2"
        ? "l2"
        : e.normalize === "none" || e.normalise === "none"
          ? "provider"
          : undefined,
  };
}

export type PoolParityFailure =
  | "digest_mismatch"
  | "dimension_mismatch"
  | "processing_mismatch"
  | "count_mismatch";

/**
 * Why a pool result must not be written under the local profile, or `null`
 * when it may. Applied on receipt, after the coordinator's own checks, so a
 * worker that lies about its model still cannot reach the index.
 */
export function poolResultParityFailure(params: {
  local: EmbeddingProfile;
  remote: PoolExecutionProfile;
  vectors: number[][];
  expectedCount: number;
}): { reason: PoolParityFailure; detail: string } | null {
  const { local, remote, vectors } = params;
  if (vectors.length !== params.expectedCount) {
    return {
      reason: "count_mismatch",
      detail: `${vectors.length} vectors for ${params.expectedCount} inputs`,
    };
  }
  if (!local.modelDigest || !remote.modelDigest || local.modelDigest !== remote.modelDigest) {
    return {
      reason: "digest_mismatch",
      detail: `local ${local.modelDigest ? short(local.modelDigest) : "unknown"}, worker ${remote.modelDigest ? short(remote.modelDigest) : "unreported"}`,
    };
  }
  const dims = vectors[0]?.length ?? 0;
  if (
    !local.dimensions ||
    dims !== local.dimensions ||
    (remote.dimensions !== undefined && remote.dimensions !== local.dimensions)
  ) {
    return {
      reason: "dimension_mismatch",
      detail: `local ${local.dimensions ?? "unknown"}, worker ${remote.dimensions ?? dims}`,
    };
  }
  if (vectors.some((v) => v.length !== dims)) {
    return { reason: "dimension_mismatch", detail: "ragged vectors in result" };
  }
  // Soapbox sends truncate:false and returns raw vectors; an explicit report must say the same.
  if (remote.truncation === "provider") {
    return {
      reason: "processing_mismatch",
      detail: "worker truncates inputs; local profile does not",
    };
  }
  if (remote.normalise && remote.normalise !== "provider") {
    return {
      reason: "processing_mismatch",
      detail: `worker normalises (${remote.normalise}); vectors must arrive raw`,
    };
  }
  return null;
}
