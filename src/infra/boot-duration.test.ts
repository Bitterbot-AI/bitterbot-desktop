import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RESTART_HINT_MS,
  readLastBootDurationMs,
  recordBootDurationMs,
} from "./boot-duration.js";

const dirs: string[] = [];
const makeDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bb-boot-duration-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

describe("gateway boot duration", () => {
  it("round-trips a recorded duration", () => {
    const dir = makeDir();
    recordBootDurationMs(290_800, dir);
    expect(readLastBootDurationMs(dir)).toBe(290_800);
  });

  it("returns the default when nothing has been recorded", () => {
    expect(readLastBootDurationMs(makeDir())).toBe(DEFAULT_RESTART_HINT_MS);
  });

  it("does not advertise the old misleading 1.5s default", () => {
    // Regression guard for the bug this module exists to fix.
    expect(DEFAULT_RESTART_HINT_MS).toBeGreaterThan(1500);
  });

  it("ignores implausible values rather than persisting them", () => {
    const dir = makeDir();
    recordBootDurationMs(290_800, dir);
    recordBootDurationMs(-5, dir);
    recordBootDurationMs(Number.NaN, dir);
    recordBootDurationMs(48 * 60 * 60 * 1000, dir);
    expect(readLastBootDurationMs(dir)).toBe(290_800);
  });

  it("falls back to the default on malformed content", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "last-boot-ms.json"), "not json", "utf8");
    expect(readLastBootDurationMs(dir)).toBe(DEFAULT_RESTART_HINT_MS);
  });

  it("falls back to the default when bootMs has the wrong type", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "last-boot-ms.json"),
      JSON.stringify({ bootMs: "290" }),
      "utf8",
    );
    expect(readLastBootDurationMs(dir)).toBe(DEFAULT_RESTART_HINT_MS);
  });

  it("never throws when the state dir cannot be created", () => {
    // Use a regular file as the parent so mkdir fails with ENOTDIR immediately and
    // portably. Do NOT point this at /proc: mkdir there hangs under WSL2 rather
    // than erroring, which wedges the run instead of failing it.
    const dir = makeDir();
    const asFile = path.join(dir, "not-a-dir");
    fs.writeFileSync(asFile, "x");
    expect(() => recordBootDurationMs(1000, path.join(asFile, "nested"))).not.toThrow();
    expect(readLastBootDurationMs(path.join(asFile, "nested"))).toBe(DEFAULT_RESTART_HINT_MS);
  });

  it("overwrites an earlier record with the latest boot", () => {
    const dir = makeDir();
    recordBootDurationMs(1_537_000, dir);
    recordBootDurationMs(290_800, dir);
    expect(readLastBootDurationMs(dir)).toBe(290_800);
  });
});
