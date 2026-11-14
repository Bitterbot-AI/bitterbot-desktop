import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../../../config/config.js";
import { CONFIG_DIR } from "../../../utils.js";
import { PeerEvidenceStore } from "./evidence.js";
import { SkillPolicyService, type MembershipCheck } from "./policy.js";
import { CollectiveSkillStore } from "./store.js";
import { PackageDistribution } from "./transport.js";
import type { PackageExecutionHost } from "./validation.js";
import { PackageValidator } from "./validation.js";

export type CollectiveRuntime = {
  store: CollectiveSkillStore;
  policies: SkillPolicyService;
  distribution: PackageDistribution;
  evidence: PeerEvidenceStore;
  hosts: Map<string, PackageExecutionHost>;
  hostConfigurations?: Map<string, string>;
};
let runtime: CollectiveRuntime | null = null;
let membership: MembershipCheck = () => false;
export function registerCollectiveMembership(check: MembershipCheck): void {
  membership = check;
}
export function getCollectiveRuntime(config: BitterbotConfig): CollectiveRuntime | null {
  if (!config.skills?.collective?.enabled) return null;
  if (runtime) return runtime;
  const root = path.join(CONFIG_DIR, "collective-skills");
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "state.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
  const store = new CollectiveSkillStore(db, root);
  const policies = new SkillPolicyService(store, (circle, publisher) =>
    membership(circle, publisher),
  );
  db.prepare("UPDATE collective_jobs SET state='interrupted' WHERE state='running'").run();
  db.exec(
    "CREATE TABLE IF NOT EXISTS collective_operations(id TEXT PRIMARY KEY, agent TEXT NOT NULL, release_id TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)",
  );
  db.prepare(
    "UPDATE collective_operations SET state='blocked',detail='Interrupted; reconcile costs before retry' WHERE state='running'",
  ).run();
  runtime = {
    store,
    policies,
    distribution: new PackageDistribution(store, policies),
    evidence: new PeerEvidenceStore(store),
    hosts: new Map(),
    hostConfigurations: new Map(),
  };
  return runtime;
}
/** Host/plugin capability. Models cannot register executors or outcome checkers. */
export function registerCollectiveExecutionHost(
  config: BitterbotConfig,
  agentId: string,
  host: PackageExecutionHost,
): void {
  const value = getCollectiveRuntime(config);
  if (!value) throw new Error("Collective skills are disabled");
  value.hosts.set(agentId, host);
  value.hostConfigurations?.delete(agentId);
}
export function closeCollectiveRuntime(): void {
  runtime?.store.db.close();
  runtime = null;
  membership = () => false;
}

/** Trusted host integration only: checked production runs, never model-generated verdicts. */
export function observeCollectiveCanary(
  config: BitterbotConfig,
  agent: string,
  lineage: string,
  receipt: unknown,
  deterministicRegressionConfirmed: boolean,
): void {
  const value = getCollectiveRuntime(config),
    host = value?.hosts.get(agent);
  if (!value || !host) throw new Error("No registered collective execution host");
  new PackageValidator(value.store, host, {
    providerUsd: 0,
    toolCalls: 0,
    wallMs: 0,
  }).observeCanary(agent, lineage, receipt, deterministicRegressionConfirmed);
}
