import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect CONFIG_DIR to a temp dir so file writes don't pollute the user's profile.
let TMP: string;
vi.mock("../utils.js", async () => {
  const real = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...real,
    get CONFIG_DIR() {
      return TMP;
    },
  };
});

import {
  __considerationsConsts,
  __considerationsTodayKey,
  __resetConsiderationsForTest,
  flushConsiderationsNow,
  loadDayConsiderations,
  recentConsiderations,
  recordConsideration,
} from "./heartbeat-considerations.js";

beforeEach(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-considerations-"));
  __resetConsiderationsForTest();
});

afterEach(async () => {
  __resetConsiderationsForTest();
  try {
    await fs.rm(TMP, { recursive: true, force: true });
  } catch {}
});

describe("recordConsideration + recentConsiderations", () => {
  it("returns empty initially", () => {
    expect(recentConsiderations()).toEqual([]);
  });

  it("returns most-recent first", () => {
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "first",
      decision: "acted",
      reason: "first reason",
    });
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "second",
      decision: "skipped",
      reason: "second reason",
    });
    const out = recentConsiderations();
    expect(out.length).toBe(2);
    expect(out[0]!.subject).toBe("second");
    expect(out[1]!.subject).toBe("first");
  });

  it("filters by sessionKey", () => {
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "a",
      decision: "acted",
      reason: "x",
    });
    recordConsideration({
      sessionKey: "s2",
      category: "trigger",
      subject: "b",
      decision: "acted",
      reason: "y",
    });
    const out = recentConsiderations({ sessionKey: "s1" });
    expect(out.length).toBe(1);
    expect(out[0]!.subject).toBe("a");
  });

  it("filters by category and decision", () => {
    recordConsideration({
      sessionKey: "s1",
      category: "skill-eligibility",
      subject: "skill-a",
      decision: "blocked",
      reason: "missing bin",
    });
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "morning-brief",
      decision: "acted",
      reason: "scheduled fire",
    });
    expect(recentConsiderations({ category: "skill-eligibility" })).toHaveLength(1);
    expect(recentConsiderations({ decision: "blocked" })).toHaveLength(1);
    expect(recentConsiderations({ category: "trigger", decision: "skipped" })).toHaveLength(0);
  });

  it("respects limit", () => {
    for (let i = 0; i < 20; i++) {
      recordConsideration({
        sessionKey: "s1",
        category: "trigger",
        subject: `s-${i}`,
        decision: "acted",
        reason: "r",
      });
    }
    expect(recentConsiderations({ limit: 5 })).toHaveLength(5);
  });
});

describe("ring rotation", () => {
  it("evicts oldest entries when the ring fills, keeping only the most recent", () => {
    const big = __considerationsConsts.RING_MAX + 50;
    for (let i = 0; i < big; i++) {
      recordConsideration({
        sessionKey: "s1",
        category: "trigger",
        subject: `s-${i}`,
        decision: "acted",
        reason: "r",
      });
    }
    // The query API caps `limit` at 500; ask for 500 and verify the
    // newest 500 are returned and the oldest are gone.
    const newest500 = recentConsiderations({ limit: 500 });
    expect(newest500).toHaveLength(500);
    expect(newest500[0]!.subject).toBe(`s-${big - 1}`);
    expect(newest500[499]!.subject).toBe(`s-${big - 500}`);
    // Earliest entries should not be reachable at all.
    const earlySubjects = newest500.map((e) => e.subject);
    expect(earlySubjects).not.toContain("s-0");
    expect(earlySubjects).not.toContain(`s-${big - __considerationsConsts.RING_MAX - 1}`);
  });
});

describe("flushConsiderationsNow + loadDayConsiderations", () => {
  it("writes pending batch to today's NDJSON file", async () => {
    const now = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "morning",
      decision: "acted",
      reason: "alarm",
    });
    await flushConsiderationsNow(now);
    const day = __considerationsTodayKey(now);
    const loaded = await loadDayConsiderations(day);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.subject).toBe("morning");
  });

  it("appends across multiple flushes", async () => {
    const now = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "first",
      decision: "acted",
      reason: "r",
    });
    await flushConsiderationsNow(now);
    recordConsideration({
      sessionKey: "s1",
      category: "trigger",
      subject: "second",
      decision: "skipped",
      reason: "r2",
    });
    await flushConsiderationsNow(now);
    const day = __considerationsTodayKey(now);
    const loaded = await loadDayConsiderations(day, { limit: 100 });
    expect(loaded.map((e) => e.subject).toSorted()).toEqual(["first", "second"]);
  });

  it("loadDayConsiderations applies filters", async () => {
    const now = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
    recordConsideration({
      sessionKey: "a",
      category: "trigger",
      subject: "x",
      decision: "acted",
      reason: "r",
    });
    recordConsideration({
      sessionKey: "b",
      category: "trigger",
      subject: "y",
      decision: "skipped",
      reason: "r",
    });
    await flushConsiderationsNow(now);
    const day = __considerationsTodayKey(now);
    const loaded = await loadDayConsiderations(day, { sessionKey: "b" });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.subject).toBe("y");
  });

  it("returns [] for a day with no file", async () => {
    expect(await loadDayConsiderations("2020-01-01")).toEqual([]);
  });
});
