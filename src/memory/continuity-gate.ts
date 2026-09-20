/**
 * Session continuity gate (token-efficiency pass, 2026-09-19).
 *
 * Decides whether the latest handover brief is relevant enough to inject
 * into the system prompt. The previous implementation embedded
 * `brief.purpose` and `brief.nextSteps[0]` (the brief against itself), so
 * it always passed and cost two sequential embedding round-trips on every
 * prompt build, heartbeats included.
 *
 * Now: the brief embedding is cached by content hash (in-memory, and on disk
 * next to the brief so restarts do not re-embed), and it is compared against
 * the live user message. Callers pass the user-message embedding when they
 * already have it (proactive recall computes one), so a turn costs at most
 * one embed and usually zero.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionHandoverBrief } from "./session-handover.js";
import { cosineSimilarity } from "./internal.js";

export const CONTINUITY_GATE_THRESHOLD = 0.25;
const CACHE_FILE = ".purpose-embedding.json";

type CacheFile = { hash: string; embedding: number[] };

const memoryCache = new Map<string, number[]>();

export function briefHash(brief: Pick<SessionHandoverBrief, "purpose">): string {
  return crypto.createHash("sha256").update(brief.purpose).digest("hex").slice(0, 32);
}

export function continuityCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "handover", CACHE_FILE);
}

/** Test hook. */
export function resetContinuityGateCache(): void {
  memoryCache.clear();
}

export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Embedding of `brief.purpose`, served from the in-memory cache, then the
 * on-disk cache, then one paid embed (which populates both).
 */
export async function getBriefEmbedding(params: {
  workspaceDir: string;
  brief: Pick<SessionHandoverBrief, "purpose">;
  embed: EmbedFn;
}): Promise<{ embedding: number[]; source: "memory" | "disk" | "embed" }> {
  const hash = briefHash(params.brief);
  const key = `${params.workspaceDir}:${hash}`;
  const hit = memoryCache.get(key);
  if (hit) {
    return { embedding: hit, source: "memory" };
  }
  const cachePath = continuityCachePath(params.workspaceDir);
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, "utf-8")) as CacheFile;
    if (raw?.hash === hash && Array.isArray(raw.embedding) && raw.embedding.length > 0) {
      memoryCache.set(key, raw.embedding);
      return { embedding: raw.embedding, source: "disk" };
    }
  } catch {
    // No cache yet, or unreadable — fall through to a paid embed.
  }
  const embedding = await params.embed(params.brief.purpose);
  if (embedding.length > 0) {
    memoryCache.set(key, embedding);
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify({ hash, embedding } satisfies CacheFile));
    } catch {
      // Disk cache is an optimization only.
    }
  }
  return { embedding, source: "embed" };
}

export type ContinuityGateResult = {
  pass: boolean;
  similarity: number | null;
  /** Paid embedding calls made by this evaluation (0, 1 or 2). */
  embedCalls: number;
  reason: string;
};

/**
 * Gate the brief against the live user message. Fail-open: no user message,
 * no embed function, or any error lets the brief through.
 */
export async function evaluateContinuityGate(params: {
  workspaceDir: string;
  brief: Pick<SessionHandoverBrief, "purpose">;
  userMessage?: string;
  /** Reuse an embedding the caller already paid for (proactive recall). */
  userMessageEmbedding?: number[] | null;
  embed?: EmbedFn;
  threshold?: number;
}): Promise<ContinuityGateResult> {
  const threshold = params.threshold ?? CONTINUITY_GATE_THRESHOLD;
  if (!params.embed) {
    return { pass: true, similarity: null, embedCalls: 0, reason: "no embedder (fail-open)" };
  }
  const message = params.userMessage?.trim();
  if (!message) {
    return { pass: true, similarity: null, embedCalls: 0, reason: "no user message (fail-open)" };
  }
  let embedCalls = 0;
  try {
    const briefResult = await getBriefEmbedding({
      workspaceDir: params.workspaceDir,
      brief: params.brief,
      embed: params.embed,
    });
    if (briefResult.source === "embed") {
      embedCalls++;
    }
    let messageEmbedding = params.userMessageEmbedding ?? null;
    if (!messageEmbedding || messageEmbedding.length === 0) {
      messageEmbedding = await params.embed(message);
      embedCalls++;
    }
    if (briefResult.embedding.length === 0 || messageEmbedding.length === 0) {
      return { pass: true, similarity: null, embedCalls, reason: "empty embedding (fail-open)" };
    }
    const similarity = cosineSimilarity(briefResult.embedding, messageEmbedding);
    if (similarity < threshold) {
      return { pass: false, similarity, embedCalls, reason: "brief unrelated to current turn" };
    }
    return { pass: true, similarity, embedCalls, reason: "brief relevant" };
  } catch (err) {
    return {
      pass: true,
      similarity: null,
      embedCalls,
      reason: `gate error (fail-open): ${String(err)}`,
    };
  }
}
