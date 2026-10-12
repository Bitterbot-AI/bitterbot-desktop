/**
 * `bitterbot update preflight` (hidden; PLAN-56 Phase 3b): the activation
 * check a NEW release-tarball version runs, with its own code, before the
 * updater switches `current` to it. Read-only: it never writes config or
 * databases (the CLI's config guard and migrations skip this command).
 *
 * Blocking (the new version would not boot or would misread data):
 *   - the config file exists and fails this version's schema;
 *   - a memory database reports a schema_version newer than this version's
 *     LATEST_SCHEMA_VERSION (data written by a newer release).
 * Warnings only: legacy or deprecated keys, a database this version will
 * migrate forward on boot, a database it cannot open read-only.
 */

import path from "node:path";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { PREFLIGHT_KIND, type PreflightReport } from "../../infra/tarball-preflight.js";
import { listMemoryDatabases, readDatabaseSchemaVersion } from "../../infra/update-snapshot.js";
import { LATEST_SCHEMA_VERSION } from "../../memory/migrations.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { VERSION } from "../../version.js";

export async function runUpdatePreflight(
  params: {
    stateDir?: string;
    readSnapshot?: typeof readConfigFileSnapshot;
    readSchemaVersion?: (file: string) => Promise<number | null>;
  } = {},
): Promise<PreflightReport> {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const snapshot = await (params.readSnapshot ?? readConfigFileSnapshot)();
  if (snapshot.exists && !snapshot.valid) {
    const issues = snapshot.issues
      .slice(0, 5)
      .map((i) => `${i.path || "<root>"}: ${i.message}`)
      .join("; ");
    blocking.push(`config ${snapshot.path} fails v${VERSION}'s schema (${issues})`);
  }
  for (const legacy of snapshot.legacyIssues ?? []) {
    warnings.push(`legacy config key ${legacy.path}: ${legacy.message}`);
  }
  const readSchema = params.readSchemaVersion ?? readDatabaseSchemaVersion;
  for (const db of listMemoryDatabases(params.stateDir ?? resolveStateDir())) {
    const schema = await readSchema(db);
    const name = path.basename(db);
    if (schema === null) {
      warnings.push(`${name}: schema version unreadable`);
    } else if (schema > LATEST_SCHEMA_VERSION) {
      blocking.push(
        `${name} has memory schema ${schema}, newer than the ${LATEST_SCHEMA_VERSION} v${VERSION} knows (it was written by a newer release)`,
      );
    } else if (schema < LATEST_SCHEMA_VERSION) {
      warnings.push(
        `${name}: schema ${schema} will be migrated to ${LATEST_SCHEMA_VERSION} on boot`,
      );
    }
  }
  return {
    kind: PREFLIGHT_KIND,
    version: VERSION,
    ok: blocking.length === 0,
    blocking,
    warnings,
    memorySchemaLatest: LATEST_SCHEMA_VERSION,
  };
}

export async function updatePreflightCommand(opts: { json?: boolean }): Promise<void> {
  const report = await runUpdatePreflight();
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(report));
  } else {
    defaultRuntime.log(theme.heading(`Activation check for v${report.version}`));
    for (const line of report.blocking) {
      defaultRuntime.log(theme.error(`  blocks: ${line}`));
    }
    for (const line of report.warnings) {
      defaultRuntime.log(theme.warn(`  note: ${line}`));
    }
    defaultRuntime.log(report.ok ? theme.success("  ok") : theme.error("  refused"));
  }
  if (!report.ok) {
    defaultRuntime.exit(1);
  }
}
