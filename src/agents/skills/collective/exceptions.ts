import type { DatabaseSync } from "node:sqlite";
import {
  queuePendingOutbound,
  listPendingOutbound,
  type PendingOutbound,
} from "../../../circles/pending-outbound.js";
import { bindCollectiveCircles } from "../../../circles/skill-packages.js";
import type { BitterbotConfig } from "../../../config/config.js";
import { HashSchema, IdSchema, learningHash, type SkillRelease } from "./contracts.js";
import { getCollectiveRuntime } from "./runtime.js";
import { queuePackageOperation } from "./service.js";

export function requestPackageException(
  config: BitterbotConfig,
  db: DatabaseSync,
  agent: string,
  release: SkillRelease,
): string {
  if (release.scope.kind !== "circle")
    throw new Error("Public sharing requires a separate explicit public policy");
  const runtime = getCollectiveRuntime(config);
  const pkg = runtime?.store.get(release.packageHash);
  if (!runtime || !pkg || pkg.state !== "stable")
    throw new Error("Only stable packages can request publication");
  const releaseId = runtime.store.addRelease(release);
  const prior = listPendingOutbound(db, release.scope.circleId).find(
    (p) =>
      p.action === "share_skill" && p.params.releaseId === releaseId && p.params.agent === agent,
  );
  if (prior) return prior.id;
  return queuePendingOutbound(db, {
    circleId: release.scope.circleId,
    action: "share_skill",
    params: { releaseId, packageHash: pkg.hash, agent },
    preview: {
      name: pkg.manifest.name,
      version: release.version,
      publisher: release.publisher,
      files: pkg.manifest.files.map((f) => f.path),
      packageHash: pkg.hash,
      scope: release.scope,
      operation: "publish",
      evidenceSharing: false,
      dollars: 0,
    },
  });
}
/** Called only by the operator.approvals protected pending-outbound resolver. */
export async function approvePackageException(
  config: BitterbotConfig,
  db: DatabaseSync,
  pending: PendingOutbound,
): Promise<void> {
  if (pending.action !== "share_skill" || pending.expiresAt <= Date.now())
    throw new Error("Approval expired");
  const runtime = getCollectiveRuntime(config);
  if (!runtime) throw new Error("Collective learning disabled");
  bindCollectiveCircles(db);
  const releaseId = HashSchema.parse(pending.params.releaseId),
    hash = HashSchema.parse(pending.params.packageHash),
    agent = IdSchema.parse(pending.params.agent);
  const release = runtime.store.release(releaseId),
    pkg = runtime.store.get(hash);
  if (
    !release ||
    !pkg ||
    release.packageHash !== hash ||
    release.scope.kind !== "circle" ||
    release.scope.circleId !== pending.circleId ||
    !runtime.policies.member(pending.circleId, release.publisher)
  )
    throw new Error("Approval no longer matches this package or membership");
  await runtime.store.read(hash);
  runtime.store.assertDisclosure(hash, release.scope);
  runtime.policies.set({
    id: `exception-${pending.id}`,
    scope: release.scope,
    enabled: true,
    agents: [agent],
    publishers: [release.publisher],
    skillIds: [release.skillId],
    operations: ["publish"],
    categories: ["skill-package"],
    capabilities: pkg.manifest.requirements.capabilities,
    packageHashes: [hash],
    budget: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
    expiresAt: pending.expiresAt,
  });
  runtime.store.audit("exception-approved", learningHash(release), { approval: pending.id });
  queuePackageOperation(runtime, agent, releaseId, "publish");
}
