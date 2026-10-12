import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../../config/types.bitterbot.js";
import { LATEST_SCHEMA_VERSION } from "../../memory/migrations.js";
import { VERSION } from "../../version.js";
import { runUpdatePreflight } from "./preflight.js";

function snapshot(partial: Partial<ConfigFileSnapshot>): () => Promise<ConfigFileSnapshot> {
  return async () =>
    ({
      path: "/tmp/bitterbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
      ...partial,
    }) as ConfigFileSnapshot;
}

function stateWithDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-preflight-"));
  fs.mkdirSync(path.join(dir, "memory"));
  fs.writeFileSync(path.join(dir, "memory", "main.sqlite"), "");
  return dir;
}

describe("update preflight (the activation check a new version runs)", () => {
  it("passes a valid config and a database this version can migrate forward", async () => {
    const stateDir = stateWithDb();
    const report = await runUpdatePreflight({
      stateDir,
      readSnapshot: snapshot({}),
      readSchemaVersion: async () => LATEST_SCHEMA_VERSION - 1,
    });
    expect(report).toMatchObject({
      kind: "bitterbot-update-preflight",
      version: VERSION,
      ok: true,
    });
    expect(report.warnings.join(" ")).toContain("will be migrated");
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("blocks a config that fails this version's schema", async () => {
    const report = await runUpdatePreflight({
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-preflight-")),
      readSnapshot: snapshot({ valid: false, issues: [{ path: "gateway.port", message: "bad" }] }),
    });
    expect(report.ok).toBe(false);
    expect(report.blocking[0]).toContain("gateway.port: bad");
  });

  it("blocks a database written by a newer release (schema newer than this version knows)", async () => {
    const stateDir = stateWithDb();
    const report = await runUpdatePreflight({
      stateDir,
      readSnapshot: snapshot({ exists: false }),
      readSchemaVersion: async () => LATEST_SCHEMA_VERSION + 1,
    });
    expect(report.ok).toBe(false);
    expect(report.blocking[0]).toContain("main.sqlite");
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("no config file and no databases is fine (fresh install)", async () => {
    const report = await runUpdatePreflight({
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-preflight-")),
      readSnapshot: snapshot({ exists: false }),
    });
    expect(report.ok).toBe(true);
  });
});
