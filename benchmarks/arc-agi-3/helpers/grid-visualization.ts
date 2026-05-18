/**
 * Grid visualization helpers (matches partner-template helpers/grid-visualization.js).
 *
 * ASCII art renderers Claude Code uses to view grids in terminal logs.
 * Pure functions, no I/O.
 */

import type { Grid } from "./frame-analysis.js";

/** Default 16-glyph palette for ASCII rendering. */
const DEFAULT_PALETTE: string[] = [
  " ", // 0 background
  "·", // 1
  "▒", // 2
  "█", // 3
  "▓", // 4
  "*", // 5
  "+", // 6
  "x", // 7
  "o", // 8
  "O", // 9
  "#", // 10
  "@", // 11
  "%", // 12
  "&", // 13
  "$", // 14
  "?", // 15 unknown
];

export function gridToAscii(grid: Grid, palette: string[] = DEFAULT_PALETTE): string {
  return grid.map((row) => row.map((v) => palette[v] ?? palette[15]!).join("")).join("\n");
}

export function displayRegion(
  grid: Grid,
  centerRow: number,
  centerCol: number,
  radius: number,
): string {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const rTop = Math.max(0, centerRow - radius);
  const rBot = Math.min(rows - 1, centerRow + radius);
  const cLeft = Math.max(0, centerCol - radius);
  const cRight = Math.min(cols - 1, centerCol + radius);
  const lines: string[] = [];
  // Header with column indices
  const colHeader =
    "    " +
    Array.from({ length: cRight - cLeft + 1 }, (_, i) => String((cLeft + i) % 10)).join("");
  lines.push(colHeader);
  for (let r = rTop; r <= rBot; r++) {
    const row = grid[r]!;
    const slice = row
      .slice(cLeft, cRight + 1)
      .map((v) => DEFAULT_PALETTE[v] ?? "?")
      .join("");
    lines.push(`${String(r).padStart(3, " ")} ${slice}`);
  }
  return lines.join("\n");
}

/**
 * Downsample a large grid into a coarse overview by averaging
 * `scale`-sized cells into dominant-color blocks.
 */
export function createGridSummary(grid: Grid, scale = 4): string {
  if (scale < 1) scale = 1;
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const outRows = Math.ceil(rows / scale);
  const outCols = Math.ceil(cols / scale);
  const out: number[][] = Array.from({ length: outRows }, () => new Array<number>(outCols).fill(0));
  for (let R = 0; R < outRows; R++) {
    for (let C = 0; C < outCols; C++) {
      const counts: Record<number, number> = {};
      for (let r = R * scale; r < Math.min(rows, (R + 1) * scale); r++) {
        for (let c = C * scale; c < Math.min(cols, (C + 1) * scale); c++) {
          const v = grid[r]![c]!;
          counts[v] = (counts[v] ?? 0) + 1;
        }
      }
      let best = 0;
      let bestCount = -1;
      for (const [k, v] of Object.entries(counts)) {
        if (v > bestCount) {
          bestCount = v;
          best = Number(k);
        }
      }
      out[R]![C] = best;
    }
  }
  return gridToAscii(out);
}

export function highlightPositions(
  grid: Grid,
  positions: Array<{ row: number; col: number }>,
  highlightChar = "*",
): string {
  const overlay = grid.map((row) => row.map((v) => DEFAULT_PALETTE[v] ?? "?"));
  for (const { row, col } of positions) {
    if (row >= 0 && row < overlay.length) {
      const r = overlay[row]!;
      if (col >= 0 && col < r.length) {
        r[col] = highlightChar;
      }
    }
  }
  return overlay.map((row) => row.join("")).join("\n");
}

export function compareSideBySide(a: Grid, b: Grid, maxWidth = 80): string {
  const aLines = gridToAscii(a).split("\n");
  const bLines = gridToAscii(b).split("\n");
  const aWidth = aLines[0]?.length ?? 0;
  const bWidth = bLines[0]?.length ?? 0;
  const gap = "  │  ";
  const rows = Math.max(aLines.length, bLines.length);
  if (aWidth + bWidth + gap.length > maxWidth) {
    // Stack vertically with a separator if too wide.
    return ["── before ──", ...aLines, "── after ──", ...bLines].join("\n");
  }
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = (aLines[i] ?? "").padEnd(aWidth, " ");
    const right = bLines[i] ?? "";
    out.push(`${left}${gap}${right}`);
  }
  return out.join("\n");
}
