/**
 * Tests for the PLAN-21 Phase E longmemeval 20/10/70 train/selection/test
 * split. Uses a synthetic dataset written to a temp file — no dependency on
 * the real longmemeval_s.json.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_SELECTION_BUCKET_CEILING,
  DEFAULT_TRAIN_BUCKET_CEILING,
  type LongMemEvalItem,
  loadDataset,
  loadDatasetSplit,
  selectSplit,
  splitBucket,
} from "./adapter.js";

function makeItem(id: string): LongMemEvalItem {
  return {
    question_id: id,
    question_type: "single-session-user",
    question: `Q: ${id}`,
    answer: `A: ${id}`,
    question_date: "2026-01-01",
    haystack_dates: [],
    haystack_session_ids: [],
    haystack_sessions: [],
    answer_session_ids: [],
  };
}

describe("loadDatasetSplit", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan21-split-"));
    path = join(dir, "dataset.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("partitions deterministically: same input produces the same split", () => {
    const items = Array.from({ length: 500 }, (_, i) => makeItem(`q-${i}`));
    writeFileSync(path, JSON.stringify(items), "utf-8");

    const split1 = loadDatasetSplit(path);
    const split2 = loadDatasetSplit(path);

    expect(split1.train.map((i) => i.question_id)).toEqual(split2.train.map((i) => i.question_id));
    expect(split1.selection.map((i) => i.question_id)).toEqual(
      split2.selection.map((i) => i.question_id),
    );
    expect(split1.test.map((i) => i.question_id)).toEqual(split2.test.map((i) => i.question_id));
  });

  it("splits roughly into 20/10/70 ratios within bucket-quantisation tolerance", () => {
    // 1000 items gives enough samples to land near the ratios.
    const items = Array.from({ length: 1000 }, (_, i) => makeItem(`q-ratio-${i}`));
    writeFileSync(path, JSON.stringify(items), "utf-8");

    const split = loadDatasetSplit(path);
    const total = items.length;
    const trainPct = split.train.length / total;
    const selPct = split.selection.length / total;
    const testPct = split.test.length / total;

    // Tolerance ±5pp (sha1 mod 100 has visible quantisation noise on
    // structured IDs; real longmemeval ids have much more entropy).
    expect(trainPct).toBeGreaterThan(0.15);
    expect(trainPct).toBeLessThan(0.25);
    expect(selPct).toBeGreaterThan(0.05);
    expect(selPct).toBeLessThan(0.15);
    expect(testPct).toBeGreaterThan(0.65);
    expect(testPct).toBeLessThan(0.75);
  });

  it("preserves union: train + selection + test == all", () => {
    const items = Array.from({ length: 200 }, (_, i) => makeItem(`q-union-${i}`));
    writeFileSync(path, JSON.stringify(items), "utf-8");

    const split = loadDatasetSplit(path);
    expect(split.train.length + split.selection.length + split.test.length).toBe(split.all.length);
    expect(split.all.length).toBe(items.length);
  });

  it("respects custom ceilings", () => {
    const items = Array.from({ length: 200 }, (_, i) => makeItem(`q-custom-${i}`));
    writeFileSync(path, JSON.stringify(items), "utf-8");

    const split = loadDatasetSplit(path, { trainCeiling: 50, selectionCeiling: 60 });
    // ~50% train / 10% selection / 40% test
    const trainPct = split.train.length / items.length;
    expect(trainPct).toBeGreaterThan(0.4);
    expect(trainPct).toBeLessThan(0.6);
  });

  it("rejects invalid ceilings", () => {
    writeFileSync(path, "[]", "utf-8");
    expect(() => loadDatasetSplit(path, { trainCeiling: -1 })).toThrow();
    expect(() => loadDatasetSplit(path, { trainCeiling: 50, selectionCeiling: 40 })).toThrow();
    expect(() => loadDatasetSplit(path, { trainCeiling: 50, selectionCeiling: 101 })).toThrow();
  });

  it("default ceilings are 20 and 30", () => {
    expect(DEFAULT_TRAIN_BUCKET_CEILING).toBe(20);
    expect(DEFAULT_SELECTION_BUCKET_CEILING).toBe(30);
  });
});

describe("splitBucket", () => {
  it("is deterministic across calls", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `q-${i}`);
    const a = ids.map((id) => splitBucket(id));
    const b = ids.map((id) => splitBucket(id));
    expect(a).toEqual(b);
  });

  it("returns values in [0, 99]", () => {
    for (let i = 0; i < 50; i++) {
      const b = splitBucket(`sample-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it("returns different buckets for different ids", () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      buckets.add(splitBucket(`u-${i}`));
    }
    // ≥10 distinct buckets out of 50 ids is plenty of spread.
    expect(buckets.size).toBeGreaterThan(10);
  });
});

describe("selectSplit", () => {
  it("returns the requested split by name", () => {
    const items = Array.from({ length: 100 }, (_, i) => makeItem(`q-sel-${i}`));
    const dir = mkdtempSync(join(tmpdir(), "plan21-sel-"));
    const path = join(dir, "dataset.json");
    writeFileSync(path, JSON.stringify(items), "utf-8");
    try {
      const split = loadDatasetSplit(path);
      expect(selectSplit(split, "train")).toBe(split.train);
      expect(selectSplit(split, "selection")).toBe(split.selection);
      expect(selectSplit(split, "test")).toBe(split.test);
      expect(selectSplit(split, "all")).toBe(split.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadDataset (backwards-compat)", () => {
  it("still returns the flat array shape", () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem(`q-compat-${i}`));
    const dir = mkdtempSync(join(tmpdir(), "plan21-compat-"));
    const path = join(dir, "dataset.json");
    writeFileSync(path, JSON.stringify(items), "utf-8");
    try {
      const ds = loadDataset(path);
      expect(Array.isArray(ds)).toBe(true);
      expect(ds.length).toBe(5);
      expect(ds[0]?.question_id).toBe("q-compat-0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
