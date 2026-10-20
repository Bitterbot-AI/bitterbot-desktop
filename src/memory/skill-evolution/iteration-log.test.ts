import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendIterationRecord,
  type IterationRecord,
  iterationLogPath,
  MAX_RECORDS,
  readRecentIterations,
} from "./iteration-log.js";

function rec(n: number): IterationRecord {
  return {
    at: n,
    cycleId: `c${n}`,
    durationMs: 1,
    ran: true,
    reason: null,
    cursorBefore: n,
    cursorAfter: n + 1,
    sampler: null,
    maintainer: null,
    proposer: null,
    validation: [],
    lint: null,
    published: 0,
    error: null,
  };
}

describe("iteration log (PLAN-44 I12)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "iter-log-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends and reads newest-last, skipping torn lines", async () => {
    const opts = { configDir: tmpDir };
    await appendIterationRecord(rec(1), opts);
    await appendIterationRecord(rec(2), opts);
    await fs.appendFile(iterationLogPath(opts), "{not json\n", "utf-8");
    await appendIterationRecord(rec(3), opts);
    const all = await readRecentIterations(10, opts);
    expect(all.map((r) => r.at)).toEqual([1, 2, 3]);
    expect((await readRecentIterations(1, opts)).map((r) => r.at)).toEqual([3]);
  });

  it("trims to MAX_RECORDS once the file passes twice that", async () => {
    const opts = { configDir: tmpDir };
    for (let i = 0; i <= MAX_RECORDS * 2; i++) {
      await appendIterationRecord(rec(i), opts);
    }
    const raw = await fs.readFile(iterationLogPath(opts), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(MAX_RECORDS);
    expect(JSON.parse(lines.at(-1)!).at).toBe(MAX_RECORDS * 2);
  });

  it("returns [] when the log does not exist", async () => {
    expect(await readRecentIterations(5, { configDir: tmpDir })).toEqual([]);
  });
});
