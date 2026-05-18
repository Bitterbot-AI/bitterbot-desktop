import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareGrids,
  compareFrames,
  getFrameFiles,
  getGrid,
  loadFrame,
  printDifferenceSummary,
} from "../helpers/frame-analysis.js";
import {
  analyzeColorDistribution,
  detectRepeatingPattern,
  findConnectedComponents,
  findRectangularRegions,
  findRowPatterns,
  getColumn,
  getRow,
} from "../helpers/grid-analysis.js";
import {
  compareSideBySide,
  createGridSummary,
  displayRegion,
  gridToAscii,
  highlightPositions,
} from "../helpers/grid-visualization.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-helpers-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const G1 = [
  [0, 0, 1],
  [0, 1, 1],
  [2, 0, 0],
];
const G2 = [
  [0, 0, 1],
  [0, 1, 1],
  [3, 0, 0],
];

describe("frame-analysis", () => {
  it("compareGrids returns per-cell diffs", () => {
    const diffs = compareGrids(G1, G2);
    expect(diffs).toEqual([{ row: 2, col: 0, oldVal: 2, newVal: 3 }]);
  });

  it("compareGrids throws on shape mismatch", () => {
    expect(() => compareGrids(G1, [[0]])).toThrow();
  });

  it("loadFrame + getGrid round-trip via disk", () => {
    const fp = path.join(tmpDir, "frame_0000.json");
    fs.writeFileSync(fp, JSON.stringify({ index: 0, frame: [G1] }));
    const f = loadFrame(fp);
    expect(getGrid(f)).toEqual(G1);
  });

  it("compareFrames reads two files and diffs", () => {
    const p1 = path.join(tmpDir, "frame_0000.json");
    const p2 = path.join(tmpDir, "frame_0001.json");
    fs.writeFileSync(p1, JSON.stringify({ index: 0, frame: [G1] }));
    fs.writeFileSync(p2, JSON.stringify({ index: 1, frame: [G2] }));
    expect(compareFrames(p1, p2)).toEqual([{ row: 2, col: 0, oldVal: 2, newVal: 3 }]);
  });

  it("getFrameFiles returns sorted JSON files", () => {
    fs.writeFileSync(path.join(tmpDir, "frame_0001.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "frame_0000.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "summary.json"), "{}"); // ignored
    const files = getFrameFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/frame_0000\.json$/);
    expect(files[1]).toMatch(/frame_0001\.json$/);
  });

  it("printDifferenceSummary prints zero-diff message", () => {
    const line = printDifferenceSummary([], "ACTION1");
    expect(line).toContain("NO_CHANGE");
  });
});

describe("grid-analysis", () => {
  it("analyzeColorDistribution counts cells and picks dominant", () => {
    const d = analyzeColorDistribution(G1);
    expect(d.totalCells).toBe(9);
    expect(d.counts[0]).toBe(5);
    expect(d.counts[1]).toBe(3);
    expect(d.dominantColor).toBe(0);
  });

  it("findConnectedComponents finds 4-connected regions", () => {
    const grid = [
      [1, 1, 0, 1],
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ];
    const comps = findConnectedComponents(grid, 1);
    expect(comps).toHaveLength(2); // top-left "L" and right column block
  });

  it("findRectangularRegions returns bounding boxes sorted by area", () => {
    const grid = [
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
    ];
    const rects = findRectangularRegions(grid, 1);
    expect(rects).toHaveLength(2);
    expect(rects[0]!.area).toBe(4);
    expect(rects[1]!.area).toBe(1);
  });

  it("detectRepeatingPattern finds a tile", () => {
    expect(detectRepeatingPattern([1, 2, 1, 2, 1, 2])).toMatchObject({
      pattern: [1, 2],
      repeatCount: 3,
    });
    expect(detectRepeatingPattern([1, 2, 3])).toBeNull();
  });

  it("getRow + getColumn extract correctly", () => {
    expect(getRow(G1, 1)).toEqual([0, 1, 1]);
    expect(getColumn(G1, 2)).toEqual([1, 1, 0]);
    expect(() => getRow(G1, 99)).toThrow();
  });

  it("findRowPatterns surfaces repeating rows", () => {
    const grid = [
      [1, 2, 1, 2],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ];
    const patterns = findRowPatterns(grid);
    expect(patterns.length).toBeGreaterThanOrEqual(2);
  });
});

describe("grid-visualization", () => {
  it("gridToAscii renders with palette", () => {
    const ascii = gridToAscii([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(ascii.split("\n")).toHaveLength(2);
    expect(ascii).toContain("█"); // value 3
  });

  it("displayRegion shows requested radius around center", () => {
    const out = displayRegion(G1, 1, 1, 1);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("createGridSummary downsamples", () => {
    const grid = Array.from({ length: 16 }, () => new Array<number>(16).fill(7));
    const summary = createGridSummary(grid, 4);
    const lines = summary.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]!.length).toBe(4);
  });

  it("highlightPositions marks cells with a custom char", () => {
    const out = highlightPositions(G1, [{ row: 0, col: 0 }], "*");
    expect(out.split("\n")[0]).toMatch(/^\*/);
  });

  it("compareSideBySide renders both grids", () => {
    const out = compareSideBySide(G1, G2);
    expect(out).toContain("│");
  });
});
