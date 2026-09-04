/**
 * PLAN-44 Phase 0: persisted per-iteration telemetry.
 *
 * Audit finding: after five live iterations nothing machine-readable
 * survived — only the maintainer's prose log line and one provenance row.
 * Sampler stats, prompt sizes, parse issues, proposer turns and protocol
 * errors, and gate outcomes lived in a gateway log that no longer existed.
 * This file (`skill-wiki/iterations.jsonl`) records one JSON object per
 * iteration ATTEMPT, including no-op and crashed attempts, so the loop can
 * be diagnosed from disk. Bounded: trimmed to the newest `MAX_RECORDS`
 * whenever it grows past twice that.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SamplerStats } from "./types.js";
import { type ImpactTrailOptions, resolveWikiDir } from "../../agents/skills/impact-trail.js";
import { atomicWriteFile } from "./fs-atomic.js";

export const ITERATION_LOG_FILENAME = "iterations.jsonl";
export const MAX_RECORDS = 500;

export interface IterationRecord {
  at: number;
  cycleId: string | null;
  durationMs: number;
  ran: boolean;
  reason: string | null;
  cursorBefore: number | null;
  cursorAfter: number | null;
  sampler: Record<string, number> | null;
  maintainer: {
    applied: boolean;
    created: number;
    updated: number;
    dropped: number;
    promptChars: number;
    parseIssues: string[];
  } | null;
  proposer: {
    action: string;
    turns: number;
    reads: number;
    protocolErrors: number;
    forced: boolean;
    outcome: string | null;
    lane: string | null;
  } | null;
  validation: Array<{ skillName: string; outcome: string; detail?: string }>;
  lint: { archived: number; orphans: number } | null;
  published: number;
  error: string | null;
}

/** Structural view of an EvolutionPassResult (avoids a circular import). */
export interface IterationSource {
  ran: boolean;
  reason?: string;
  error?: string;
  cursorBefore?: number;
  cursorAfter?: number;
  samplerStats?: SamplerStats;
  maintenance?: {
    applied: boolean;
    promptChars: number;
    parseIssues?: string[];
    apply?: { created: string[]; updated: string[]; dropped: unknown[] };
  };
  proposer?: {
    proposal: { action: string };
    turns: number;
    reads: string[];
    protocolErrors: number;
    forced: boolean;
    lane?: string;
  };
  proposalOutcome?: { outcome: string };
  validation?: Array<{ skillName: string; outcome: string; detail?: string }>;
  lint?: { archivedDuplicates: string[]; archivedOverflow: string[]; orphans: string[] };
  publish?: { published: string[] };
}

/** Flatten a pass result into the on-disk telemetry shape. Pure. */
export function buildIterationRecord(
  result: IterationSource,
  meta: { startedAt: number; cycleId: string | null },
): IterationRecord {
  const apply = result.maintenance?.apply;
  return {
    at: meta.startedAt,
    cycleId: meta.cycleId,
    durationMs: Date.now() - meta.startedAt,
    ran: result.ran,
    reason: result.reason ?? null,
    cursorBefore: result.cursorBefore ?? null,
    cursorAfter: result.cursorAfter ?? null,
    sampler: result.samplerStats ? { ...result.samplerStats } : null,
    maintainer: result.maintenance
      ? {
          applied: result.maintenance.applied,
          created: apply?.created.length ?? 0,
          updated: apply?.updated.length ?? 0,
          dropped: apply?.dropped.length ?? 0,
          promptChars: result.maintenance.promptChars,
          parseIssues: (result.maintenance.parseIssues ?? []).slice(0, 10),
        }
      : null,
    proposer: result.proposer
      ? {
          action: result.proposer.proposal.action,
          turns: result.proposer.turns,
          reads: result.proposer.reads.length,
          protocolErrors: result.proposer.protocolErrors,
          forced: result.proposer.forced,
          outcome: result.proposalOutcome?.outcome ?? null,
          lane: result.proposer.lane ?? null,
        }
      : null,
    validation: (result.validation ?? []).map((v) => ({
      skillName: v.skillName,
      outcome: v.outcome,
      ...(v.detail ? { detail: v.detail.slice(0, 300) } : {}),
    })),
    lint: result.lint
      ? {
          archived: result.lint.archivedDuplicates.length + result.lint.archivedOverflow.length,
          orphans: result.lint.orphans.length,
        }
      : null,
    published: result.publish?.published.length ?? 0,
    error: result.error ?? null,
  };
}

export function iterationLogPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), ITERATION_LOG_FILENAME);
}

/** Append one record; trim when the file is past 2x MAX_RECORDS. */
export async function appendIterationRecord(
  record: IterationRecord,
  opts: ImpactTrailOptions = {},
): Promise<void> {
  const p = iterationLogPath(opts);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(p, line, "utf-8");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length > MAX_RECORDS * 2) {
    await atomicWriteFile(p, `${lines.slice(-MAX_RECORDS).join("\n")}\n`);
  }
}

/** Newest-last slice of the log; malformed lines are skipped. */
export async function readRecentIterations(
  limit = 10,
  opts: ImpactTrailOptions = {},
): Promise<IterationRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(iterationLogPath(opts), "utf-8");
  } catch {
    return [];
  }
  const out: IterationRecord[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as IterationRecord);
    } catch {
      // skip torn line
    }
  }
  return out;
}
