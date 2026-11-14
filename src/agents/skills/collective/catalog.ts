import type { SkillRelease } from "./contracts.js";
import { ReceiptSchema, learningHash } from "./contracts.js";
import type { CollectiveSkillStore } from "./store.js";

/** Local checks drive priority. Signed remote claims remain explicitly reported evidence. */
export function packageSignals(store: CollectiveSkillStore, release: SkillRelease) {
  const pkg = store.get(release.packageHash);
  const receipts = (
    store.db
      .prepare("SELECT body FROM collective_receipts WHERE hash=? LIMIT 1000")
      .all(release.packageHash) as { body: string }[]
  ).map((r) => ReceiptSchema.parse(JSON.parse(r.body)));
  const current = receipts.filter(
    (r) =>
      learningHash(r.environment) === pkg?.environment &&
      r.cost &&
      r.accessedFiles.includes("SKILL.md") &&
      ["pass", "task-failure"].includes(r.outcome),
  );
  const successRate = current.length
    ? current.filter((r) => r.outcome === "pass").length / current.length
    : null;
  const reports = store.db
    .prepare("SELECT DISTINCT origin FROM collective_evidence WHERE hash=? AND origin!=?")
    .all(release.packageHash, release.publisher);
  return {
    compatibleCheckedRuns: current.length,
    localSuccessRate: successRate,
    independentReporters: reports.length,
    evidenceStatus: current.length ? "local-execution" : "unqualified",
    usefulness: null,
    priority:
      (pkg?.state === "stable" ? 100 : pkg?.state === "locally-validated" ? 50 : 0) +
      (successRate ?? 0) * 10 +
      Math.min(reports.length, 8) / 10 +
      Math.min(current.length, 1000) / 10000,
  };
}

export function operationalCounts(store: CollectiveSkillStore) {
  const count = (sql: string) => Number(store.db.prepare(sql).get()?.n ?? 0);
  const last = store.db
    .prepare("SELECT body FROM collective_audit WHERE kind='rollback' ORDER BY id DESC LIMIT 1")
    .get() as { body: string } | undefined;
  return {
    transfers:
      count("SELECT COUNT(*) AS n FROM collective_deliveries WHERE state='delivered'") +
      count("SELECT COUNT(*) AS n FROM collective_audit WHERE kind='package-received'"),
    blockedDownloads: count(
      "SELECT COUNT(*) AS n FROM collective_audit WHERE kind='download-blocked'",
    ),
    adoptions: count("SELECT COUNT(*) AS n FROM collective_audit WHERE kind='activated'"),
    uncertainTransfers: count(
      "SELECT COUNT(*) AS n FROM collective_deliveries WHERE state='uncertain'",
    ),
    waitingJobs: count(
      "SELECT COUNT(*) AS n FROM collective_operations WHERE state IN ('queued','blocked')",
    ),
    activePackages: count("SELECT COUNT(*) AS n FROM collective_active"),
    regressions: count(
      "SELECT COUNT(*) AS n FROM collective_audit WHERE kind='rollback' AND json_extract(body,'$.reason')='confirmed-runtime-regression'",
    ),
    rollbackLatencyMs: last ? (JSON.parse(last.body).latencyMs ?? null) : null,
    audit: "counts-only",
  };
}
