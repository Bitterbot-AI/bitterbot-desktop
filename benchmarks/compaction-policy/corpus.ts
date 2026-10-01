/**
 * PLAN-52A compaction-policy evaluation: corpus assembly.
 *
 * Copies real session transcripts into an isolated eval state directory
 * (`<root>/state/agents/eval/sessions/`) so nothing the harness does can touch
 * the live agent. Four sets (PLAN-52A Section 5.1):
 *   A  the three sessions that ever exceeded 100k prompt tokens
 *   B  the largest dialogue sessions by real (non-heartbeat) user turns
 *   C  stitched runs of consecutive sessions (multi-day continuity)
 *   D  the August 2026 planted-fact sessions
 *
 * Pure helpers (ranking, stitching) are exported for tests.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  isHeartbeatPromptText,
  transcriptMessageText,
} from "../../src/agents/runtime/compaction/heartbeat.js";
import { parseJsonl } from "../../src/agents/runtime/compaction/transcript-view.js";

export type CorpusSet = "A" | "B" | "C" | "D";

export type CorpusSession = {
  set: CorpusSet;
  /** Session id = file stem in the eval sessions dir. */
  sessionId: string;
  filePath: string;
  /** Source transcript file names (several for stitched sessions). */
  sources: string[];
  realUserTurns: number;
  estTokens: number;
};

export type CorpusManifest = {
  builtAt: string;
  sourceDir: string;
  sessions: CorpusSession[];
};

/** Set A and D are named by id prefix; the file may be live, `.reset.*` or `.deleted.*`. */
export const SET_A_PREFIXES = ["938dddcb", "71741a9e", "55e8b2f4"];
export const SET_D_PREFIXES = ["0bac215f", "d8dd5843", "fa280d0d"];

export function stemOf(fileName: string): string {
  return fileName.replace(/\.jsonl(\..*)?$/, "");
}

export function isTranscriptName(name: string): boolean {
  return /\.jsonl(\.(reset|deleted)\..*)?$/.test(name) && !name.startsWith("a2a-");
}

export type SessionStats = {
  file: string;
  stem: string;
  realUserTurns: number;
  userTurns: number;
  estTokens: number;
  firstTs: number | null;
};

export function statsFromJsonl(
  file: string,
  raw: string,
  heartbeatPrompts: readonly string[],
): SessionStats {
  let realUserTurns = 0;
  let userTurns = 0;
  let chars = 0;
  let firstTs: number | null = null;
  for (const r of parseJsonl(raw)) {
    if (r.type !== "message") {
      continue;
    }
    const m = r.message as Record<string, unknown> | undefined;
    chars += JSON.stringify(m?.content ?? "").length;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(ts) && firstTs === null) {
      firstTs = ts;
    }
    if (m?.role === "user") {
      userTurns++;
      if (!isHeartbeatPromptText(transcriptMessageText(m), heartbeatPrompts)) {
        realUserTurns++;
      }
    }
  }
  return {
    file,
    stem: stemOf(path.basename(file)),
    realUserTurns,
    userTurns,
    estTokens: Math.ceil(chars / 4),
    firstTs,
  };
}

/** Rank for set B: most real user turns first, then size. */
export function rankForSetB(
  stats: SessionStats[],
  exclude: Set<string>,
  minRealTurns: number,
  max: number,
): SessionStats[] {
  return stats
    .filter(
      (s) =>
        !exclude.has(s.stem.slice(0, 8)) &&
        s.realUserTurns >= minRealTurns &&
        !s.stem.startsWith("drill-"),
    )
    .toSorted((a, b) => b.realUserTurns - a.realUserTurns || b.estTokens - a.estTokens)
    .slice(0, max);
}

/**
 * Stitch several transcripts into one path: ids are prefixed per source so
 * they stay unique, the first record of each later session is re-parented to
 * the last id of the previous one, and only the first `session` header is kept.
 */
export function stitchTranscripts(
  parts: Array<{ stem: string; raw: string }>,
  stitchId: string,
): string {
  const out: string[] = [];
  let lastId: string | null = null;
  let headerWritten = false;
  parts.forEach((part, k) => {
    const prefix = `s${k}-`;
    const records = parseJsonl(part.raw);
    for (const r of records) {
      const rec: Record<string, unknown> = { ...r };
      delete rec.__line;
      if (rec.type === "session") {
        if (!headerWritten) {
          rec.id = stitchId;
          out.push(JSON.stringify(rec));
          headerWritten = true;
        }
        continue;
      }
      if (typeof rec.id === "string") {
        rec.id = prefix + rec.id;
      }
      if (typeof rec.parentId === "string") {
        rec.parentId = prefix + rec.parentId;
      } else if (rec.parentId === null || rec.parentId === undefined) {
        rec.parentId = lastId;
      }
      out.push(JSON.stringify(rec));
      if (typeof rec.id === "string") {
        lastId = rec.id;
      }
    }
  });
  return out.join("\n") + "\n";
}

/** Choose runs of `size` consecutive sessions (by first timestamp) with enough real turns. */
export function chooseStitchRuns(
  stats: SessionStats[],
  size: number,
  minRealTurns: number,
  max: number,
): SessionStats[][] {
  const ordered = stats
    .filter((s) => s.firstTs !== null && !s.stem.startsWith("drill-"))
    .toSorted((a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0));
  const runs: SessionStats[][] = [];
  for (let i = 0; i + size <= ordered.length && runs.length < max; i += size) {
    const run = ordered.slice(i, i + size);
    const real = run.reduce((n, s) => n + s.realUserTurns, 0);
    if (real >= minRealTurns) {
      runs.push(run);
    }
  }
  return runs;
}

export async function buildCorpus(params: {
  sourceDir: string;
  evalSessionsDir: string;
  heartbeatPrompts: readonly string[];
  setBMax?: number;
  setBMinRealTurns?: number;
  stitchRuns?: number;
  stitchSize?: number;
}): Promise<CorpusManifest> {
  const { sourceDir, evalSessionsDir } = params;
  await fs.mkdir(evalSessionsDir, { recursive: true });
  const names = (await fs.readdir(sourceDir)).filter(isTranscriptName);
  const stats: SessionStats[] = [];
  const rawByStem = new Map<string, string>();
  for (const name of names) {
    const file = path.join(sourceDir, name);
    const raw = await fs.readFile(file, "utf-8");
    const st = statsFromJsonl(file, raw, params.heartbeatPrompts);
    stats.push(st);
    // Prefer the live file over archives when both exist for one stem.
    if (!rawByStem.has(st.stem) || name.endsWith(".jsonl")) {
      rawByStem.set(st.stem, raw);
    }
  }
  const byPrefix = (prefix: string) => stats.find((s) => s.stem.startsWith(prefix));
  const sessions: CorpusSession[] = [];
  const copy = async (set: CorpusSet, st: SessionStats, raw: string, sources: string[]) => {
    const target = path.join(evalSessionsDir, `${st.stem}.jsonl`);
    await fs.writeFile(target, raw, "utf-8");
    sessions.push({
      set,
      sessionId: st.stem,
      filePath: target,
      sources,
      realUserTurns: st.realUserTurns,
      estTokens: st.estTokens,
    });
  };

  const used = new Set<string>();
  for (const p of SET_A_PREFIXES) {
    const st = byPrefix(p);
    if (st) {
      await copy("A", st, rawByStem.get(st.stem)!, [path.basename(st.file)]);
      used.add(p);
    }
  }
  for (const p of SET_D_PREFIXES) {
    const st = byPrefix(p);
    if (st) {
      await copy("D", st, rawByStem.get(st.stem)!, [path.basename(st.file)]);
      used.add(p);
    }
  }
  const live = stats.filter((s) => s.file.endsWith(".jsonl"));
  for (const st of rankForSetB(live, used, params.setBMinRealTurns ?? 4, params.setBMax ?? 12)) {
    await copy("B", st, rawByStem.get(st.stem)!, [path.basename(st.file)]);
    used.add(st.stem.slice(0, 8));
  }
  const runs = chooseStitchRuns(
    live.filter((s) => !used.has(s.stem.slice(0, 8))),
    params.stitchSize ?? 3,
    6,
    params.stitchRuns ?? 8,
  );
  let n = 0;
  for (const run of runs) {
    n++;
    const stitchId = `stitch-${String(n).padStart(2, "0")}`;
    const raw = stitchTranscripts(
      run.map((s) => ({ stem: s.stem, raw: rawByStem.get(s.stem)! })),
      stitchId,
    );
    const st: SessionStats = {
      file: stitchId,
      stem: stitchId,
      realUserTurns: run.reduce((a, s) => a + s.realUserTurns, 0),
      userTurns: run.reduce((a, s) => a + s.userTurns, 0),
      estTokens: run.reduce((a, s) => a + s.estTokens, 0),
      firstTs: run[0]!.firstTs,
    };
    await copy(
      "C",
      st,
      raw,
      run.map((s) => path.basename(s.file)),
    );
  }
  return { builtAt: new Date().toISOString(), sourceDir, sessions };
}
