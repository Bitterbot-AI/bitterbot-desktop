/**
 * PLAN-44 Phase 0: persisted sampler state (`skill-wiki/.sampler-state.json`).
 * Split out of sampler.ts (500-line cap). Every write is atomic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PendingRun } from "./types.js";
import { resolveWikiDir } from "../../agents/skills/impact-trail.js";
import { atomicWriteJson } from "./fs-atomic.js";

/** PLAN-44 Phase 0: pending-list bound. */
export const PENDING_MAX = 50;
/** PLAN-44 Phase 0: anti-rescan ring of examined run ids. */
export const PROCESSED_RING_MAX = 200;

const SAMPLER_STATE_FILENAME = ".sampler-state.json";

export interface SamplerStateOptions {
  /** Defaults to CONFIG_DIR (state lives beside the wiki). Tests override. */
  configDir?: string;
}

export interface SamplerState {
  cursorSeq: number;
  updatedAt: number;
  /** PLAN-44 Phase 0: in-flight runs awaiting a terminal event. */
  pending: PendingRun[];
  /** PLAN-44 Phase 0: recently examined run ids (anti-rescan). */
  processed: string[];
  /**
   * PLAN-44 (adversarial C1): consecutive maintainer parse failures at this
   * cursor. The window is retried up to MAX_PARSE_FAILURES times, then
   * skipped — otherwise one prose-inducing trace pins the loop forever.
   */
  parseFailures: { cursorSeq: number; count: number } | null;
}

export const MAX_PARSE_FAILURES = 3;

function samplerStatePath(opts: SamplerStateOptions): string {
  return path.join(resolveWikiDir(opts), SAMPLER_STATE_FILENAME);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function readSamplerState(opts: SamplerStateOptions = {}): Promise<SamplerState> {
  try {
    const raw = await fs.readFile(samplerStatePath(opts), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pending = Array.isArray(parsed.pending)
      ? parsed.pending
          .filter(
            (p): p is { runId: string; firstSeenAt: number } =>
              !!p &&
              typeof p === "object" &&
              typeof (p as { runId?: unknown }).runId === "string" &&
              typeof (p as { firstSeenAt?: unknown }).firstSeenAt === "number",
          )
          .map((p) => ({ runId: p.runId, firstSeenAt: p.firstSeenAt }))
      : [];
    const processed = Array.isArray(parsed.processed)
      ? parsed.processed.filter((p): p is string => typeof p === "string")
      : [];
    const pf = parsed.parseFailures as { cursorSeq?: unknown; count?: unknown } | null | undefined;
    const parseFailures =
      pf &&
      typeof pf === "object" &&
      typeof pf.cursorSeq === "number" &&
      typeof pf.count === "number"
        ? { cursorSeq: pf.cursorSeq, count: pf.count }
        : null;
    return {
      cursorSeq: num(parsed.cursorSeq),
      updatedAt: num(parsed.updatedAt),
      pending: pending.slice(-PENDING_MAX),
      processed: processed.slice(-PROCESSED_RING_MAX),
      parseFailures,
    };
  } catch {
    return { cursorSeq: 0, updatedAt: 0, pending: [], processed: [], parseFailures: null };
  }
}

export async function readSamplerCursor(opts: SamplerStateOptions = {}): Promise<number> {
  return (await readSamplerState(opts)).cursorSeq;
}

/** Atomic; stamps updatedAt (the dream engine's cadence gate reads it). */
export async function writeSamplerState(
  state: Omit<SamplerState, "updatedAt" | "parseFailures"> & {
    parseFailures?: SamplerState["parseFailures"];
  },
  opts: SamplerStateOptions = {},
): Promise<void> {
  await atomicWriteJson(samplerStatePath(opts), {
    cursorSeq: state.cursorSeq,
    updatedAt: Date.now(),
    pending: state.pending.slice(-PENDING_MAX),
    processed: state.processed.slice(-PROCESSED_RING_MAX),
    parseFailures: state.parseFailures ?? null,
  });
}

/** Cursor-only update that PRESERVES the pending list, processed ring, and failure count. */
export async function writeSamplerCursor(
  cursorSeq: number,
  opts: SamplerStateOptions = {},
): Promise<void> {
  const prev = await readSamplerState(opts);
  await writeSamplerState(
    {
      cursorSeq,
      pending: prev.pending,
      processed: prev.processed,
      parseFailures: prev.parseFailures,
    },
    opts,
  );
}
