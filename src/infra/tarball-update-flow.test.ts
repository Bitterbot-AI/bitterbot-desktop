/**
 * The tarball update's boot deadline (PLAN-56 Phase 3b): a new version that
 * migrates memory databases on its first boot gets more time before the
 * watchdog rolls it back. State dirs are temp directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { recordBootDurationMs } from "./boot-duration.js";
import {
  armTarballBootVerify,
  pendingMigrationCount,
  tarballBootDeadlineMs,
} from "./tarball-update-flow.js";

const MIN = 60_000;
const envSnapshot = captureFullEnv();

describe("tarball boot deadline", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-deadline-"));
    process.env.BITTERBOT_STATE_DIR = stateDir;
  });
  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("triples (up to 90 minutes) when the new version migrates databases on boot", () => {
    expect(tarballBootDeadlineMs(stateDir)).toBe(5 * MIN);
    expect(tarballBootDeadlineMs(stateDir, { pendingMigrations: 1 })).toBe(15 * MIN);
    recordBootDurationMs(8 * MIN, stateDir);
    expect(tarballBootDeadlineMs(stateDir)).toBe(24 * MIN);
    expect(tarballBootDeadlineMs(stateDir, { pendingMigrations: 2 })).toBe(72 * MIN);
    recordBootDurationMs(20 * MIN, stateDir);
    expect(tarballBootDeadlineMs(stateDir)).toBe(30 * MIN);
    expect(tarballBootDeadlineMs(stateDir, { pendingMigrations: 1 })).toBe(90 * MIN);
  });

  it("counts pending migrations from the activation check (explicit, or its notes)", () => {
    expect(pendingMigrationCount(null)).toBe(0);
    expect(pendingMigrationCount({ warnings: [], pendingMigrations: 3 })).toBe(3);
    expect(
      pendingMigrationCount({
        warnings: [
          "main.sqlite: schema 70 will be migrated to 78 on boot",
          "legacy config key a.b: moved",
        ],
      }),
    ).toBe(1);
  });

  it("the armed beacon carries the extended deadline and the gateway port", () => {
    const ctx = {
      appDir: path.join(stateDir, "app"),
      fromVersion: "1.4.0",
      autoRollback: true,
      memorySchemaLatest: 70,
      gatewayPort: 19555,
    };
    const plain = armTarballBootVerify({
      ctx,
      toVersion: "1.5.0",
      snapshotDir: null,
      restart: "respawn",
      reason: "test",
      preflight: { warnings: [] },
    })!;
    expect(plain.deadlineAt - plain.armedAt).toBe(5 * MIN);
    expect(plain.tarball?.gatewayPort).toBe(19555);
    const migrating = armTarballBootVerify({
      ctx,
      toVersion: "1.5.0",
      snapshotDir: null,
      restart: "respawn",
      reason: "test",
      preflight: { warnings: [], pendingMigrations: 1 },
    })!;
    expect(migrating.deadlineAt - migrating.armedAt).toBe(15 * MIN);
  });
});
