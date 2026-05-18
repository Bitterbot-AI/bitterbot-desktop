/**
 * Grid pattern analysis helpers (matches partner-template helpers/grid-analysis.js).
 *
 * Pure functions over 2D integer grids. No I/O. Used by Claude Code
 * inside its agent loop and by the transition harvester for feature
 * extraction.
 */

import type { Grid } from "./frame-analysis.js";

export interface ColorDistribution {
  counts: Record<number, number>;
  percentages: Record<number, number>;
  totalCells: number;
  dominantColor: number;
}

/** Color counts + percentages + dominant color. */
export function analyzeColorDistribution(grid: Grid): ColorDistribution {
  const counts: Record<number, number> = {};
  let total = 0;
  for (const row of grid) {
    for (const v of row) {
      counts[v] = (counts[v] ?? 0) + 1;
      total++;
    }
  }
  const percentages: Record<number, number> = {};
  let dominant = -1;
  let dominantCount = -1;
  for (const [k, v] of Object.entries(counts)) {
    const numK = Number(k);
    percentages[numK] = total === 0 ? 0 : v / total;
    if (v > dominantCount) {
      dominantCount = v;
      dominant = numK;
    }
  }
  return { counts, percentages, totalCells: total, dominantColor: dominant };
}

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  color: number;
  area: number;
}

/**
 * Find the largest axis-aligned rectangles of `targetColor` via a
 * greedy sweep. Not exhaustive (real "maximal rectangle" is NP for
 * arbitrary patterns) — returns one rectangle per connected region's
 * bounding box, sorted by area descending.
 */
export function findRectangularRegions(grid: Grid, targetColor: number): Rect[] {
  const components = findConnectedComponents(grid, targetColor);
  return components
    .map((positions) => {
      let top = Number.POSITIVE_INFINITY;
      let left = Number.POSITIVE_INFINITY;
      let bottom = -Infinity;
      let right = -Infinity;
      for (const { row, col } of positions) {
        if (row < top) top = row;
        if (row > bottom) bottom = row;
        if (col < left) left = col;
        if (col > right) right = col;
      }
      return {
        top,
        left,
        bottom,
        right,
        color: targetColor,
        area: (bottom - top + 1) * (right - left + 1),
      };
    })
    .toSorted((a, b) => b.area - a.area);
}

export interface RepeatingPattern {
  pattern: number[];
  repeatCount: number;
  startIndex: number;
  patternLength: number;
}

/**
 * Detect a simple repeating pattern in a 1D array. Walks pattern
 * lengths 1..floor(N/2), returns the first one that tiles cleanly
 * from index 0 with ≥2 repetitions. Returns null if none found.
 */
export function detectRepeatingPattern(seq: number[]): RepeatingPattern | null {
  if (seq.length < 2) return null;
  for (let len = 1; len <= Math.floor(seq.length / 2); len++) {
    const head = seq.slice(0, len);
    let valid = true;
    let repeats = 0;
    for (let i = 0; i + len <= seq.length; i += len) {
      const slice = seq.slice(i, i + len);
      if (slice.length !== len) break;
      for (let j = 0; j < len; j++) {
        if (slice[j] !== head[j]) {
          valid = false;
          break;
        }
      }
      if (!valid) break;
      repeats++;
    }
    if (valid && repeats >= 2) {
      return { pattern: head, repeatCount: repeats, startIndex: 0, patternLength: len };
    }
  }
  return null;
}

export function getRow(grid: Grid, rowIndex: number): number[] {
  const row = grid[rowIndex];
  if (!row) throw new Error(`getRow: row ${rowIndex} out of bounds`);
  return [...row];
}

export function getColumn(grid: Grid, colIndex: number): number[] {
  return grid.map((row) => {
    const v = row[colIndex];
    if (v === undefined) {
      throw new Error(`getColumn: col ${colIndex} out of bounds`);
    }
    return v;
  });
}

export function findRowPatterns(grid: Grid): Array<{ row: number; pattern: RepeatingPattern }> {
  const out: Array<{ row: number; pattern: RepeatingPattern }> = [];
  for (let r = 0; r < grid.length; r++) {
    const p = detectRepeatingPattern(grid[r]!);
    if (p) out.push({ row: r, pattern: p });
  }
  return out;
}

export function findColumnPatterns(grid: Grid): Array<{ col: number; pattern: RepeatingPattern }> {
  const out: Array<{ col: number; pattern: RepeatingPattern }> = [];
  const cols = grid[0]?.length ?? 0;
  for (let c = 0; c < cols; c++) {
    const p = detectRepeatingPattern(getColumn(grid, c));
    if (p) out.push({ col: c, pattern: p });
  }
  return out;
}

/**
 * 4-connected flood fill. Returns one position array per component
 * of cells matching `targetColor`.
 */
export function findConnectedComponents(
  grid: Grid,
  targetColor: number,
): Array<Array<{ row: number; col: number }>> {
  if (grid.length === 0) return [];
  const rows = grid.length;
  const cols = grid[0]!.length;
  const visited = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const components: Array<Array<{ row: number; col: number }>> = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r]![c] || grid[r]![c] !== targetColor) continue;
      const positions: Array<{ row: number; col: number }> = [];
      const stack: Array<[number, number]> = [[r, c]];
      while (stack.length > 0) {
        const [rr, cc] = stack.pop()!;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (visited[rr]![cc]) continue;
        if (grid[rr]![cc] !== targetColor) continue;
        visited[rr]![cc] = true;
        positions.push({ row: rr, col: cc });
        stack.push([rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]);
      }
      if (positions.length > 0) components.push(positions);
    }
  }
  return components;
}
