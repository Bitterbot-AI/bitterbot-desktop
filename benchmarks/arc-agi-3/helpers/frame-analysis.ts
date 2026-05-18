/**
 * Frame analysis helpers (matches partner-template helpers/frame-analysis.js).
 *
 * Pure functions Claude Code can call via tsx or import from agent code.
 * No Bitterbot dependencies — these are general-purpose grid utilities.
 */

import fs from "node:fs";
import path from "node:path";

export type Grid = number[][];

export interface FrameRecord {
  index: number;
  timestamp?: string;
  action_input?: { id: number; data?: Record<string, unknown> };
  caption?: string;
  state?: string;
  levels_completed?: number;
  win_levels?: number;
  available_actions?: number[];
  frame: number[][][];
  pixel_changes_from_prev?: number;
}

/** Load a frame JSON file from disk. Throws on parse failure. */
export function loadFrame(framePath: string): FrameRecord {
  const raw = fs.readFileSync(framePath, "utf8");
  const obj = JSON.parse(raw) as FrameRecord;
  if (!Array.isArray(obj.frame) || obj.frame.length === 0) {
    throw new Error(`loadFrame: ${framePath} has no frames`);
  }
  return obj;
}

/** Extract the canonical (last) 2D grid from a FrameRecord. */
export function getGrid(frame: FrameRecord): Grid {
  const last = frame.frame.at(-1);
  if (!last) {
    throw new Error("getGrid: frame.frame array is empty");
  }
  return last;
}

export interface PixelDiff {
  row: number;
  col: number;
  oldVal: number;
  newVal: number;
}

/**
 * Compare two FrameRecords (by path). Returns one PixelDiff per
 * changed cell on the last grid. Throws on shape mismatch.
 */
export function compareFrames(frame1Path: string, frame2Path: string): PixelDiff[] {
  return compareGrids(getGrid(loadFrame(frame1Path)), getGrid(loadFrame(frame2Path)));
}

/** Lower-level: diff two grids directly. */
export function compareGrids(a: Grid, b: Grid): PixelDiff[] {
  if (a.length !== b.length) {
    throw new Error(`compareGrids: row count mismatch (${a.length} vs ${b.length})`);
  }
  const diffs: PixelDiff[] = [];
  for (let r = 0; r < a.length; r++) {
    const ra = a[r]!;
    const rb = b[r]!;
    if (ra.length !== rb.length) {
      throw new Error(`compareGrids: row ${r} length mismatch (${ra.length} vs ${rb.length})`);
    }
    for (let c = 0; c < ra.length; c++) {
      if (ra[c] !== rb[c]) {
        diffs.push({ row: r, col: c, oldVal: ra[c]!, newVal: rb[c]! });
      }
    }
  }
  return diffs;
}

/**
 * Print a human-readable summary of pixel diffs (used by Claude Code's
 * bash output). Returns the formatted string so callers can also store.
 */
export function printDifferenceSummary(diffs: PixelDiff[], actionName?: string): string {
  const head = actionName ? `[${actionName}] ` : "";
  if (diffs.length === 0) {
    const line = `${head}NO_CHANGE (0 pixels changed)`;
    console.log(line);
    return line;
  }
  const sample = diffs.slice(0, 5).map((d) => `(${d.row},${d.col}) ${d.oldVal}→${d.newVal}`);
  const tail = diffs.length > 5 ? `, +${diffs.length - 5} more` : "";
  const line = `${head}${diffs.length} pixel(s) changed: ${sample.join("; ")}${tail}`;
  console.log(line);
  return line;
}

/** Enumerate frame JSON files in a session directory, sorted ascending. */
export function getFrameFiles(sessionDir: string): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir)
    .filter((f) => /^frame_\d+\.json$/.test(f))
    .map((f) => path.join(sessionDir, f))
    .toSorted();
}
