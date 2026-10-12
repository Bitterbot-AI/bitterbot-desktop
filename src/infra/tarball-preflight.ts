/**
 * The contract between a release-tarball updater and the NEW version it is
 * about to activate (PLAN-56 Phase 3b): `bin/bitterbot update preflight
 * --json` prints one PreflightReport (src/cli/update-cli/preflight.ts).
 */

/** Marks the JSON `bitterbot update preflight --json` prints. */
export const PREFLIGHT_KIND = "bitterbot-update-preflight";

export type PreflightReport = {
  kind: typeof PREFLIGHT_KIND;
  version: string;
  ok: boolean;
  blocking: string[];
  warnings: string[];
  memorySchemaLatest: number;
  /** Memory databases this version migrates forward on its first boot. */
  pendingMigrations?: number;
};
