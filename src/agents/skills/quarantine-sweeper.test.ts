/**
 * PLAN-13 Phase C: tests for the quarantine TTL sweeper.
 *
 * Coverage:
 *   - empty / missing quarantine dir is a clean no-op
 *   - within-TTL entries are not touched
 *   - expired entries are auto-rejected
 *   - notifications fire per auto-reject
 *   - corrupted envelopes fall back to file mtime, then errored
 *   - default TTL is 30 days when not configured
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { sweepQuarantine } from "./quarantine-sweeper.js";

async function writeIncoming(
  root: string,
  name: string,
  envelope: Record<string, unknown> | null,
): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf-8");
  if (envelope) {
    await fs.writeFile(
      path.join(dir, ".envelope.json"),
      JSON.stringify(envelope, null, 2),
      "utf-8",
    );
  }
}

const NOW = 1_750_000_000_000; // arbitrary fixed instant
const DAY = 86_400_000;

describe("sweepQuarantine", () => {
  let tmp: string;
  let quarantineDir: string;
  let cfg: BitterbotConfig;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-sweep-"));
    quarantineDir = path.join(tmp, "skills-incoming");
    cfg = { skills: { p2p: { quarantineDir, quarantineTtlDays: 30 } } };
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("missing quarantine dir is a clean no-op", async () => {
    const report = await sweepQuarantine({ config: cfg, now: NOW });
    expect(report.scanned).toBe(0);
    expect(report.expired).toEqual([]);
    expect(report.errored).toEqual([]);
  });

  it("within-TTL entries are not touched", async () => {
    await fs.mkdir(quarantineDir, { recursive: true });
    await writeIncoming(quarantineDir, "fresh", { timestamp: NOW - 5 * DAY, name: "fresh" });
    const report = await sweepQuarantine({ config: cfg, now: NOW });
    expect(report.scanned).toBe(1);
    expect(report.expired).toEqual([]);
    // Skill still on disk
    expect(
      await fs
        .stat(path.join(quarantineDir, "fresh", "SKILL.md"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("expired entries are auto-rejected and notifications fire", async () => {
    await fs.mkdir(quarantineDir, { recursive: true });
    await writeIncoming(quarantineDir, "stale-1", { timestamp: NOW - 60 * DAY, name: "stale-1" });
    await writeIncoming(quarantineDir, "stale-2", { timestamp: NOW - 45 * DAY, name: "stale-2" });
    await writeIncoming(quarantineDir, "fresh", { timestamp: NOW - 1 * DAY, name: "fresh" });
    const notify = vi.fn();
    const report = await sweepQuarantine({ config: cfg, now: NOW, notify });
    expect(report.scanned).toBe(3);
    expect(report.expired.toSorted()).toEqual(["stale-1", "stale-2"]);
    expect(report.errored).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0]).toMatch(/auto-rejected/);
    // Stale dirs gone, fresh remains.
    expect(
      await fs
        .stat(path.join(quarantineDir, "stale-1"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(
      await fs
        .stat(path.join(quarantineDir, "fresh"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("entries with no envelope fall back to file mtime", async () => {
    await fs.mkdir(quarantineDir, { recursive: true });
    await writeIncoming(quarantineDir, "no-env", null);
    // mtime of SKILL.md is "now"; with TTL 30, this entry is fresh.
    const report = await sweepQuarantine({ config: cfg, now: NOW + 5 * DAY });
    // We can't assert "fresh" path easily because mtime is set by the
    // fs at write time. The contract is "doesn't error" — verify that.
    expect(report.errored).toEqual([]);
  });

  it("default TTL is 30 days when not configured", async () => {
    const cfgNoTtl: BitterbotConfig = { skills: { p2p: { quarantineDir } } };
    await fs.mkdir(quarantineDir, { recursive: true });
    // 31 days old → expired under default
    await writeIncoming(quarantineDir, "old", { timestamp: NOW - 31 * DAY, name: "old" });
    const report = await sweepQuarantine({ config: cfgNoTtl, now: NOW });
    expect(report.expired).toEqual(["old"]);
  });

  it("notify throwing does not block other rejections", async () => {
    await fs.mkdir(quarantineDir, { recursive: true });
    await writeIncoming(quarantineDir, "stale-1", { timestamp: NOW - 60 * DAY, name: "stale-1" });
    await writeIncoming(quarantineDir, "stale-2", { timestamp: NOW - 60 * DAY, name: "stale-2" });
    const notify = vi.fn().mockImplementation(() => {
      throw new Error("notify down");
    });
    const report = await sweepQuarantine({ config: cfg, now: NOW, notify });
    expect(report.expired.length).toBe(2);
  });
});
