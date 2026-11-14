import { randomUUID } from "node:crypto";
import { CirclesService } from "../../../circles/service.js";
import { bindCollectiveCircles } from "../../../circles/skill-packages.js";
import { keyPairFromPrivateKeyPem } from "../../../commerce/envelope.js";
import type { BitterbotConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import { loadOrCreateDeviceIdentity } from "../../../infra/device-identity.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getMemorySearchManager } from "../../../memory/index.js";
import { resolveDefaultAgentId } from "../../agent-scope.js";
import { learningHash, lineageId, type SkillRelease } from "./contracts.js";
import { packageHostConfiguration } from "./isolated-config.js";
import { getPackageMesh } from "./mesh.js";
import { createResearchBriefHost } from "./research-brief.js";
import { getCollectiveRuntime, type CollectiveRuntime } from "./runtime.js";
import { resolvePackageSandboxImage } from "./sandbox-image.js";
import { signRelease } from "./signatures.js";
import { receivePackage, type PackageTransport } from "./transport.js";
import type { PackageExecutionHost } from "./validation.js";
import { PackageValidator } from "./validation.js";

const log = createSubsystemLogger("skills/packages/service");
export function collectiveIdentity() {
  return keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
}
export async function packageTransport(
  config: BitterbotConfig,
  release: SkillRelease,
): Promise<PackageTransport> {
  if (release.scope.kind === "public") {
    const mesh = getPackageMesh();
    if (!mesh || !config.skills?.collective?.publicMesh)
      throw new Error("Public package mesh unavailable");
    return mesh.transport(release);
  }
  if (release.scope.kind !== "circle" || !config.circles?.enabled)
    throw new Error("Circle package transport unavailable");
  const { manager } = await getMemorySearchManager({
    cfg: config,
    agentId: resolveDefaultAgentId(config),
  });
  const db = (
    manager as unknown as { getCirclesDb?: () => import("node:sqlite").DatabaseSync } | null
  )?.getCirclesDb?.();
  if (!db) throw new Error("Circle database unavailable");
  bindCollectiveCircles(db);
  return new CirclesService({ db, config }).createSkillPackageTransport(
    release.scope.circleId,
    release.publisher,
  );
}

export function ensureOperationSchema(runtime: CollectiveRuntime): void {
  runtime.store.db.exec(
    "CREATE TABLE IF NOT EXISTS collective_operations(id TEXT PRIMARY KEY, agent TEXT NOT NULL, release_id TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)",
  );
}
export function queuePackageOperation(
  runtime: CollectiveRuntime,
  agent: string,
  releaseId: string,
  action: "validate" | "adopt" | "publish" | "canary",
): string {
  ensureOperationSchema(runtime);
  if (!runtime.store.release(releaseId)) throw new Error("Unknown or withdrawn release");
  const prior = runtime.store.db
    .prepare(
      "SELECT id FROM collective_operations WHERE agent=? AND release_id=? AND action=? AND state IN ('queued','running')",
    )
    .get(agent, releaseId, action) as { id: string } | undefined;
  if (prior) return prior.id;
  const id = randomUUID();
  runtime.store.db
    .prepare("INSERT INTO collective_operations VALUES (?,?,?,?,'queued',NULL,?)")
    .run(id, agent, releaseId, action, runtime.store.now());
  return id;
}

export async function ensurePackageHost(
  runtime: CollectiveRuntime,
  cfg: BitterbotConfig,
  agent: string,
) {
  let host = runtime.hosts.get(agent);
  if (host && !runtime.hostConfigurations?.has(agent)) return host;
  const image = await resolvePackageSandboxImage(cfg, agent);
  const configurationHash = learningHash({
    configuration: packageHostConfiguration(cfg, agent),
    image,
  });
  if (
    runtime.hostConfigurations?.has(agent) &&
    runtime.hostConfigurations.get(agent) !== configurationHash
  )
    host = undefined;
  if (!host) {
    host = await createResearchBriefHost(
      cfg,
      agent,
      `ed25519:${collectiveIdentity().publicKeyHex}`,
      randomUUID(),
      image,
    );
    runtime.hosts.set(agent, host);
    (runtime.hostConfigurations ??= new Map()).set(agent, configurationHash);
  }
  return host;
}
let working = false;
let workerTimer: ReturnType<typeof setInterval> | undefined;
let workerAbort = new AbortController();
/** Discovery is inert without a current, matching evaluation grant. */
export function queueAuthorizedDiscoveries(runtime: CollectiveRuntime): void {
  ensureOperationSchema(runtime);
  for (const policy of runtime.policies.list()) {
    if (
      !policy.enabled ||
      policy.expiresAt <= runtime.store.now() ||
      !policy.operations.includes("evaluate") ||
      !policy.categories.includes("skill-package")
    )
      continue;
    const rows = runtime.store.db
      .prepare(
        "SELECT id,body FROM collective_releases WHERE withdrawn=0 ORDER BY version DESC LIMIT 500",
      )
      .all() as { id: string; body: string }[];
    for (const row of rows) {
      const release = JSON.parse(row.body) as SkillRelease;
      if (
        learningHash(release.scope) !== learningHash(policy.scope) ||
        !policy.publishers.includes(release.publisher) ||
        !policy.skillIds.includes(release.skillId)
      )
        continue;
      if (
        release.scope.kind === "circle" &&
        !runtime.policies.member(release.scope.circleId, release.publisher)
      )
        continue;
      for (const agent of policy.agents) {
        const pkg = runtime.store.get(release.packageHash);
        if (pkg && ["locally-validated", "stable"].includes(pkg.state)) {
          if (
            policy.operations.includes("adopt") &&
            runtime.store.active(agent, lineageId(release))?.hash !== release.packageHash &&
            !runtime.store.db
              .prepare(
                "SELECT 1 FROM collective_operations WHERE agent=? AND release_id=? AND action='adopt'",
              )
              .get(agent, row.id)
          )
            queuePackageOperation(runtime, agent, row.id, "adopt");
          continue;
        }
        if (
          !runtime.store.db
            .prepare(
              "SELECT 1 FROM collective_operations WHERE agent=? AND release_id=? AND action='validate'",
            )
            .get(agent, row.id)
        )
          queuePackageOperation(runtime, agent, row.id, "validate");
      }
    }
  }
}
export function queueAuthorizedPublications(
  runtime: CollectiveRuntime,
  config: BitterbotConfig,
): void {
  const key = collectiveIdentity(),
    publisher = `ed25519:${key.publicKeyHex}`;
  const local = runtime.store.db
    .prepare(
      "SELECT body FROM collective_releases WHERE withdrawn=0 AND scope=? ORDER BY version DESC LIMIT 500",
    )
    .all(JSON.stringify({ kind: "private" })) as { body: string }[];
  for (const policy of runtime.policies.list()) {
    if (
      (policy.scope.kind === "public" && !config.skills?.collective?.publicMesh) ||
      (policy.scope.kind === "circle" && !config.circles?.enabled)
    )
      continue;
    if (
      !policy.enabled ||
      policy.expiresAt <= runtime.store.now() ||
      !policy.publishers.includes(publisher) ||
      !policy.operations.includes("publish") ||
      !policy.categories.includes("skill-package")
    )
      continue;
    const handled = new Set<string>();
    for (const row of local) {
      const source = JSON.parse(row.body) as SkillRelease;
      if (
        source.publisher !== publisher ||
        !policy.skillIds.includes(source.skillId) ||
        handled.has(source.skillId) ||
        runtime.store.get(source.packageHash)?.state !== "stable"
      )
        continue;
      handled.add(source.skillId);
      const prior = runtime.store.db
        .prepare(
          "SELECT id,body,withdrawn FROM collective_releases WHERE lineage=? AND scope=? ORDER BY version DESC LIMIT 1",
        )
        .get(lineageId(source), JSON.stringify(policy.scope)) as
        | { id: string; body: string; withdrawn: number }
        | undefined;
      const previous = prior ? (JSON.parse(prior.body) as SkillRelease) : null;
      if (prior?.withdrawn && previous?.packageHash === source.packageHash) continue;
      const release =
        previous?.packageHash === source.packageHash
          ? previous
          : signRelease(
              {
                protocol: "bitterbot/skill-release/1",
                publisher,
                skillId: source.skillId,
                version: (previous?.version ?? 0) + 1,
                packageHash: source.packageHash,
                requirementsSummary: runtime.store.get(source.packageHash)!.manifest.requirements,
                previousRelease: prior?.id ?? null,
                parents: previous ? [previous.packageHash] : [],
                scope: policy.scope,
                issuedAt: runtime.store.now(),
              },
              key,
            );
      for (const agent of policy.agents) {
        try {
          runtime.policies.authorize(agent, release, "publish", "skill-package");
          runtime.store.assertDisclosure(release.packageHash, release.scope);
        } catch {
          continue;
        }
        const id = runtime.store.addRelease(release);
        const delivery = runtime.store.db
          .prepare("SELECT state,updated_at FROM collective_deliveries WHERE id=?")
          .get(id) as { state: string; updated_at: number } | undefined;
        if (
          delivery?.state === "delivered" ||
          (delivery && runtime.store.now() - delivery.updated_at < 300000)
        )
          continue;
        const recent = runtime.store.db
          .prepare(
            "SELECT created_at FROM collective_operations WHERE agent=? AND release_id=? AND action='publish' ORDER BY created_at DESC LIMIT 1",
          )
          .get(agent, id) as { created_at: number } | undefined;
        if (!recent || runtime.store.now() - recent.created_at >= 300000)
          queuePackageOperation(runtime, agent, id, "publish");
      }
    }
  }
}
/** Durable jobs are claimed once. Interrupted paid jobs wait for host cost reconciliation. */
export async function workPackageQueue(config: BitterbotConfig = loadConfig()): Promise<void> {
  if (working) return;
  const runtime = getCollectiveRuntime(config);
  if (!runtime) return;
  ensureOperationSchema(runtime);
  working = true;
  try {
    if (config.circles?.enabled) {
      const { manager } = await getMemorySearchManager({
        cfg: config,
        agentId: resolveDefaultAgentId(config),
      });
      const db = (
        manager as unknown as { getCirclesDb?: () => import("node:sqlite").DatabaseSync } | null
      )?.getCirclesDb?.();
      if (db) bindCollectiveCircles(db);
    }
    queueAuthorizedDiscoveries(runtime);
    queueAuthorizedPublications(runtime, config);
    for (const [agent, host] of runtime.hosts)
      new PackageValidator(runtime.store, host, {
        providerUsd: 0,
        toolCalls: 0,
        wallMs: 0,
      }).maintain(agent);
    const job = runtime.store.db
      .prepare(
        "SELECT * FROM collective_operations WHERE state='queued' ORDER BY created_at LIMIT 1",
      )
      .get() as
      | {
          id: string;
          agent: string;
          release_id: string;
          action: "validate" | "adopt" | "publish" | "canary";
        }
      | undefined;
    if (!job) {
      const { coordinateCollective } = await import("./coordination.js");
      await coordinateCollective(config, runtime, workerAbort.signal);
      return;
    }
    if (
      !runtime.store.db
        .prepare("UPDATE collective_operations SET state='running' WHERE id=? AND state='queued'")
        .run(job.id).changes
    )
      return;
    try {
      const release = runtime.store.release(job.release_id);
      if (!release) throw new Error("Release withdrawn");
      const own = release.publisher === `ed25519:${collectiveIdentity().publicKeyHex}`;
      const transport =
        release.scope.kind === "private" ? null : await packageTransport(config, release);
      if (!runtime.store.get(release.packageHash)) {
        if (!transport) throw new Error("Missing private package");
        const authorizeDownload = () => {
          const policy = runtime.policies
            .list()
            .find(
              (p) =>
                p.enabled &&
                p.expiresAt > Date.now() &&
                p.agents.includes(job.agent) &&
                p.publishers.includes(release.publisher) &&
                p.skillIds.includes(release.skillId) &&
                (!p.packageHashes || p.packageHashes.includes(release.packageHash)) &&
                p.operations.includes("evaluate") &&
                p.categories.includes("skill-package") &&
                learningHash(p.scope) === learningHash(release.scope),
            );
          if (
            !policy ||
            (release.scope.kind === "circle" &&
              !runtime.policies.member(release.scope.circleId, release.publisher))
          )
            throw new Error("Approval required to download this package");
        };
        try {
          await receivePackage(
            runtime.store,
            release,
            transport,
            authorizeDownload,
            AbortSignal.timeout(10 * 60000),
          );
        } catch (error) {
          runtime.store.audit("download-blocked", release.packageHash, {
            reason: "transfer-or-authorization-failure",
          });
          throw error;
        }
      }
      if (job.action === "publish") {
        if (!own || !transport) throw new Error("Publisher identity or destination unavailable");
        await runtime.distribution.publish(job.agent, release, transport);
      } else {
        const proposal = runtime.store.db
          .prepare("SELECT source_release,mode FROM collective_proposal_authority WHERE hash=?")
          .get(release.packageHash) as { source_release: string; mode: string } | undefined;
        const sourceRelease = proposal ? runtime.store.release(proposal.source_release) : release;
        if (!sourceRelease) throw new Error("Proposal source withdrawn");
        const policy =
          own && release.scope.kind === "private" && !proposal
            ? null
            : runtime.policies.authorize(
                job.agent,
                sourceRelease,
                job.action === "adopt" ? "adopt" : "evaluate",
                "skill-package",
              );
        const executor = await ensurePackageHost(runtime, config, job.agent);
        const executionConfiguration = packageHostConfiguration(config, job.agent);
        const checkAuthority = () => {
          const currentConfig = loadConfig();
          if (!currentConfig.skills?.collective?.enabled)
            throw new Error("Collective learning disabled");
          if (packageHostConfiguration(currentConfig, job.agent) !== executionConfiguration)
            throw new Error("Execution environment or tool authorization changed");
          if (!runtime.store.release(job.release_id)) throw new Error("Release withdrawn");
          if (proposal && currentConfig.skills?.collective?.synthesis !== "active")
            throw new Error("Synthesis activation disabled");
          const currentPolicy = policy
            ? runtime.policies.authorize(
                job.agent,
                sourceRelease,
                job.action === "adopt" ? "adopt" : "evaluate",
                "skill-package",
              )
            : null;
          const limits = currentConfig.skills?.collective?.budget ?? {
            providerUsd: 0,
            toolCalls: 1000,
            wallMs: 3600000,
          };
          const costs = validator.ledger.costs();
          for (const dimension of ["providerUsd", "toolCalls", "wallMs"] as const) {
            if (
              costs[dimension] >
              Math.min(limits[dimension], currentPolicy?.budget[dimension] ?? Infinity)
            )
              throw new Error("Current budget no longer covers reserved execution");
          }
        };
        const host: PackageExecutionHost = {
          ...executor,
          execute: async (task, snapshot, signal) => {
            checkAuthority();
            workerAbort.signal.throwIfAborted();
            return executor.execute(task, snapshot, AbortSignal.any([signal, workerAbort.signal]));
          },
        };
        const globalBudget = config.skills?.collective?.budget ?? {
          providerUsd: 0,
          toolCalls: 1000,
          wallMs: 3600000,
        };
        const budget = policy
          ? {
              providerUsd: Math.min(policy.budget.providerUsd, globalBudget.providerUsd),
              toolCalls: Math.min(policy.budget.toolCalls, globalBudget.toolCalls),
              wallMs: Math.min(policy.budget.wallMs, globalBudget.wallMs),
            }
          : globalBudget;
        const validator = new PackageValidator(runtime.store, host, budget);
        const pkg = runtime.store.get(release.packageHash)!;
        if (job.action === "validate") {
          if (pkg.state === "candidate") await runtime.store.screen(pkg.hash);
          const verdict = await validator.validate(
            release,
            runtime.store.active(job.agent, lineageId(sourceRelease))?.hash ??
              (proposal ? sourceRelease.packageHash : null),
            AbortSignal.timeout(4 * 3600000),
          );
          if (!verdict.passed) throw new Error(verdict.reason);
          checkAuthority();
          // Adoption is separately authorized even when validation was automatic.
          if (policy) {
            try {
              runtime.policies.authorize(job.agent, sourceRelease, "adopt", "skill-package");
              queuePackageOperation(runtime, job.agent, job.release_id, "adopt");
            } catch {
              /* A passed package can wait for a later adoption grant. */
            }
          }
        } else if (job.action === "canary") {
          await validator.runCanary(
            job.agent,
            release,
            AbortSignal.timeout(budget.wallMs),
            proposal ? lineageId(sourceRelease) : undefined,
          );
          checkAuthority();
          if (runtime.store.get(release.packageHash)?.state === "canary") {
            runtime.store.db
              .prepare("UPDATE collective_operations SET state='queued' WHERE id=?")
              .run(job.id);
            return;
          }
        } else {
          if (policy)
            runtime.policies.authorize(job.agent, sourceRelease, "adopt", "skill-package");
          await runtime.store.read(release.packageHash);
          runtime.store.activate(
            job.agent,
            release,
            learningHash(host.environment),
            proposal ? lineageId(sourceRelease) : undefined,
          );
          queuePackageOperation(runtime, job.agent, job.release_id, "canary");
        }
      }
      runtime.store.db
        .prepare("UPDATE collective_operations SET state='completed' WHERE id=?")
        .run(job.id);
    } catch (error) {
      runtime.store.db
        .prepare("UPDATE collective_operations SET state='blocked',detail=? WHERE id=?")
        .run(String(error), job.id);
      log.info(`Package operation waiting: ${String(error)}`);
    }
  } finally {
    working = false;
  }
}

export function startPackageWorker(): () => void {
  if (workerTimer) return stopPackageWorker;
  workerAbort = new AbortController();
  workerTimer = setInterval(() => {
    void workPackageQueue().catch((error) => log.warn(String(error)));
  }, 30000);
  workerTimer.unref();
  return stopPackageWorker;
}
export function stopPackageWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
  workerAbort.abort();
}
