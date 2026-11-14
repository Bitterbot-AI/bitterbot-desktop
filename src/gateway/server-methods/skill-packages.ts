import path from "node:path";
import { z } from "zod";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { packageSignals, operationalCounts } from "../../agents/skills/collective/catalog.js";
import {
  HashSchema,
  IdSchema,
  RequirementsSchema,
  ScopeSchema,
  learningHash,
  lineageId,
  packageHash,
} from "../../agents/skills/collective/contracts.js";
import {
  importHermesDirectory,
  exportHermesDirectory,
  importHermesTrace,
} from "../../agents/skills/collective/hermes.js";
import { releaseLocalPackage } from "../../agents/skills/collective/local.js";
import {
  snapshotPackage,
  diffPackages,
  validateManifest,
} from "../../agents/skills/collective/package.js";
import { getCollectiveRuntime } from "../../agents/skills/collective/runtime.js";
import {
  collectiveIdentity,
  ensureOperationSchema,
  ensurePackageHost,
  queuePackageOperation,
  workPackageQueue,
  packageTransport,
} from "../../agents/skills/collective/service.js";
import { signRelease } from "../../agents/skills/collective/signatures.js";
import { createWithdrawal, withdrawRelease } from "../../agents/skills/collective/transport.js";
import { parseFrontmatter } from "../../agents/skills/frontmatter.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandler } from "./types.js";

export const PACKAGE_READ_METHODS = [
  "skills.packages.list",
  "skills.packages.inspect",
  "skills.packages.diff",
  "skills.packages.jobs",
  "skills.packages.policies",
];
export const PACKAGE_WRITE_METHODS = [
  "skills.packages.stage",
  "skills.packages.import",
  "skills.packages.validate",
  "skills.packages.adopt",
  "skills.packages.publish",
  "skills.packages.pin",
  "skills.packages.reject",
  "skills.packages.fork",
  "skills.packages.rollback",
  "skills.packages.trace",
];
export const PACKAGE_APPROVAL_METHODS = [
  "skills.packages.policy.set",
  "skills.packages.policy.revoke",
  "skills.packages.disclosure.allow",
  "skills.packages.export",
  "skills.packages.withdraw",
  "skills.packages.replace",
];

const handler: GatewayRequestHandler = async ({ req, params, respond }) => {
  try {
    const config = loadConfig(),
      runtime = getCollectiveRuntime(config);
    if (!runtime) {
      if (req.method === "skills.packages.list") {
        respond(true, { enabled: false, packages: [], releases: [] }, undefined);
        return;
      }
      throw new Error("Complete skill packages are disabled; enable skills.collective.enabled");
    }
    ensureOperationSchema(runtime);
    const { store } = runtime;
    const agent =
      typeof params.agentId === "string"
        ? IdSchema.parse(params.agentId)
        : resolveDefaultAgentId(config);
    const method = req.method.slice("skills.packages.".length);
    let result: unknown;
    if (method === "list") {
      const circleId = typeof params.circleId === "string" ? params.circleId : undefined;
      const releases = (
        store.db
          .prepare(
            "SELECT id,body FROM collective_releases WHERE withdrawn=0 ORDER BY version DESC LIMIT 500",
          )
          .all() as { id: string; body: string }[]
      )
        .map((r) => ({
          id: r.id,
          release: JSON.parse(
            r.body,
          ) as import("../../agents/skills/collective/contracts.js").SkillRelease,
        }))
        .filter(
          (r) =>
            !circleId ||
            (r.release.scope.kind === "circle" && r.release.scope.circleId === circleId),
        );
      const active = store.db.prepare("SELECT * FROM collective_active WHERE agent=?").all(agent);
      const localReleases = store.db
        .prepare(
          "SELECT id,hash FROM collective_releases WHERE withdrawn=0 AND scope=? AND lineage LIKE ? ORDER BY version DESC",
        )
        .all(
          JSON.stringify({ kind: "private" }),
          `ed25519:${collectiveIdentity().publicKeyHex}/%`,
        ) as { id: string; hash: string }[];
      const ranked = releases
        .map((entry) => ({ ...entry, signals: packageSignals(store, entry.release) }))
        .toSorted((a, b) => b.signals.priority - a.signals.priority);
      result = {
        enabled: true,
        packages: store
          .list()
          .filter((p) => !circleId || releases.some((r) => r.release.packageHash === p.hash)),
        releases: ranked,
        operational: operationalCounts(store),
        active,
        ownPackages: circleId
          ? store.list().flatMap((p) => {
              const local = localReleases.find((r) => r.hash === p.hash);
              return local ? [{ ...p, releaseId: local.id }] : [];
            })
          : [],
        costs: new (
          await import("../../memory/procedural-learning-store.js")
        ).ProceduralLearningStore(store.db).costs(),
      };
    } else if (method === "inspect") {
      const hash = HashSchema.parse(params.packageHash),
        pkg = store.get(hash);
      const snapshot = await store.read(hash);
      const file = typeof params.file === "string" ? params.file : "SKILL.md";
      const bytes = snapshot.files.get(file);
      result = {
        package: pkg,
        file,
        text: bytes && bytes.length <= 65536 ? bytes.toString("utf8") : null,
        receipts: store.db
          .prepare("SELECT body FROM collective_receipts WHERE hash=? LIMIT 100")
          .all(hash)
          .map((r) => JSON.parse(String(r.body))),
        peerEvidence: store.db
          .prepare("SELECT body FROM collective_evidence WHERE hash=? LIMIT 100")
          .all(hash)
          .map((r) => JSON.parse(String(r.body))),
      };
    } else if (method === "diff") {
      const before = params.before ? store.get(HashSchema.parse(params.before)) : null,
        after = store.get(HashSchema.parse(params.after));
      if (!after) throw new Error("Unknown package");
      result = {
        files: diffPackages(before?.manifest ?? null, after.manifest),
        requirementsChanged:
          learningHash(before?.manifest.requirements ?? null) !==
          learningHash(after.manifest.requirements),
      };
    } else if (method === "jobs")
      result = store.db
        .prepare("SELECT * FROM collective_operations ORDER BY created_at DESC LIMIT 100")
        .all();
    else if (method === "policies") result = runtime.policies.list();
    else if (method === "policy.set") result = runtime.policies.set(params.policy);
    else if (method === "policy.revoke") {
      runtime.policies.revoke(IdSchema.parse(params.id));
      result = { revoked: true };
    } else if (method === "disclosure.allow") {
      const hash = HashSchema.parse(params.packageHash),
        scope = ScopeSchema.parse(params.scope);
      if (!store.get(hash)) throw new Error("Unknown package");
      store.db
        .prepare("INSERT OR IGNORE INTO collective_disclosures VALUES (?,?)")
        .run(hash, JSON.stringify(scope));
      store.audit("disclosure-approved", hash, { scope });
      result = { approved: true, packageHash: hash, scope };
    } else if (method === "stage" || method === "import") {
      const directory = path.resolve(z.string().min(1).parse(params.directory));
      let snapshot: import("../../agents/skills/collective/contracts.js").PackageSnapshot;
      let report: unknown = null;
      if (method === "import") {
        const converted = await importHermesDirectory(directory);
        snapshot = converted.snapshot;
        report = converted.report;
      } else {
        snapshot = await snapshotPackage(
          directory,
          {
            name: "package-preview",
            description: "Local package preview.",
            requirements: RequirementsSchema.parse(params.requirements ?? {}),
          },
          z
            .array(z.string())
            .max(128)
            .parse(params.dependencies ?? []),
        );
        const frontmatter = parseFrontmatter(snapshot.files.get("SKILL.md")!.toString("utf8"));
        const manifest = validateManifest({
          ...snapshot.manifest,
          name: frontmatter.name,
          description: frontmatter.description,
        });
        snapshot = { ...snapshot, manifest, packageHash: packageHash(manifest) };
      }
      await store.install(snapshot);
      store.audit("package-import", snapshot.packageHash, { report });
      const releaseId = releaseLocalPackage(
        store,
        snapshot.packageHash,
        IdSchema.parse(params.skillId ?? snapshot.manifest.name),
      );
      result = {
        packageHash: snapshot.packageHash,
        releaseId,
        omitted: snapshot.omitted,
        compatibility: report,
        state: "candidate",
      };
    } else if (method === "export") {
      const compatibility = await exportHermesDirectory(
        await store.read(HashSchema.parse(params.packageHash)),
        z.string().min(1).parse(params.directory),
      );
      result = { exported: true, compatibility };
    } else if (method === "trace") {
      const trace = importHermesTrace(
        z.string().parse(params.trace),
        IdSchema.parse(params.taskId),
        IdSchema.parse(params.skillVersion),
      );
      store.audit("external-trace", trace.sourceHash, trace);
      result = trace;
    } else if (method === "publish") {
      const hash = HashSchema.parse(params.packageHash),
        scope = ScopeSchema.parse(params.scope),
        key = collectiveIdentity();
      if (scope.kind === "private") throw new Error("Choose a Circle or public destination");
      if (scope.kind === "public" && !config.skills?.collective?.publicMesh)
        throw new Error("Public publishing is disabled");
      const pkg = store.get(hash);
      if (!pkg) throw new Error("Unknown package");
      const skillId = IdSchema.parse(params.skillId ?? pkg.manifest.name),
        publisher = `ed25519:${key.publicKeyHex}`;
      const prior = store.db
        .prepare(
          "SELECT id,body,version FROM collective_releases WHERE lineage=? AND scope=? ORDER BY version DESC LIMIT 1",
        )
        .get(`${publisher}/${skillId}`, JSON.stringify(scope)) as
        | { id: string; body: string; version: number }
        | undefined;
      const existing = prior && store.release(prior.id);
      const release =
        existing?.packageHash === hash
          ? existing
          : signRelease(
              {
                protocol: "bitterbot/skill-release/1",
                publisher,
                skillId,
                version: (prior?.version ?? 0) + 1,
                previousRelease: prior?.id ?? null,
                parents: existing ? [existing.packageHash] : [],
                packageHash: hash,
                requirementsSummary: pkg.manifest.requirements,
                scope,
                issuedAt: Date.now(),
              },
              key,
            );
      await packageTransport(config, release); // Resolves membership before authorization.
      try {
        runtime.policies.authorize(agent, release, "publish", "skill-package");
      } catch (error) {
        if (scope.kind !== "circle") throw error;
        const { getMemorySearchManager } = await import("../../memory/index.js");
        const { manager } = await getMemorySearchManager({ cfg: config, agentId: agent });
        const db = (
          manager as unknown as { getCirclesDb?: () => import("node:sqlite").DatabaseSync } | null
        )?.getCirclesDb?.();
        if (!db) throw error;
        const { requestPackageException } =
          await import("../../agents/skills/collective/exceptions.js");
        const pendingId = requestPackageException(config, db, agent, release);
        respond(true, { pendingId, state: "awaiting-operator-approval" }, undefined);
        return;
      }
      const id = store.addRelease(release);
      result = { jobId: queuePackageOperation(runtime, agent, id, "publish"), releaseId: id };
    } else if (method === "withdraw") {
      const id = HashSchema.parse(params.releaseId),
        release = store.release(id),
        key = collectiveIdentity();
      if (release?.publisher !== `ed25519:${key.publicKeyHex}`)
        throw new Error("Only the publisher can withdraw");
      const withdrawal = createWithdrawal(id, key);
      const { ensureCoordinationSchema } =
        await import("../../agents/skills/collective/coordination.js");
      ensureCoordinationSchema(runtime);
      store.transaction(() => {
        store.db
          .prepare("INSERT OR IGNORE INTO collective_withdrawal_outbox VALUES (?,?,?,0)")
          .run(id, JSON.stringify(withdrawal), JSON.stringify(release));
        withdrawRelease(store, withdrawal);
      });
      result = { withdrawal, delivery: "queued" };
    } else {
      const releaseId = HashSchema.parse(params.releaseId),
        release = store.release(releaseId);
      if (!release) throw new Error("Unknown or withdrawn release");
      if (method === "validate" || method === "adopt")
        result = { jobId: queuePackageOperation(runtime, agent, releaseId, method) };
      else if (method === "pin") {
        store.pin(agent, lineageId(release), z.boolean().parse(params.pinned));
        result = { pinned: params.pinned };
      } else if (method === "rollback") {
        const host = await ensurePackageHost(runtime, config, agent);
        store.rollback(
          agent,
          lineageId(release),
          learningHash(host.environment),
          "operator-rollback",
        );
        result = { rolledBack: true };
      } else if (method === "replace") {
        const host = await ensurePackageHost(runtime, config, agent);
        await store.read(release.packageHash);
        store.transaction(() => {
          const before = store.active(agent, lineageId(release));
          store.db
            .prepare(
              "UPDATE collective_active SET pinned=0,customized=0 WHERE agent=? AND lineage=?",
            )
            .run(agent, lineageId(release));
          store.activate(agent, release, learningHash(host.environment));
          store.audit("explicit-local-replacement", release.packageHash, { before });
        });
        result = { replaced: true, packageHash: release.packageHash };
      } else if (method === "reject") {
        if (store.active(agent, lineageId(release))?.hash === release.packageHash)
          throw new Error("Roll back the active version first");
        store.state(release.packageHash, "blocked", "operator-rejected");
        result = { rejected: true };
      } else if (method === "fork") {
        const id = releaseLocalPackage(store, release.packageHash, IdSchema.parse(params.skillId));
        store.audit("local-fork", id, { sourceRelease: releaseId });
        store.pin(agent, lineageId(release), true);
        result = { releaseId: id, originalPinned: true };
      } else throw new Error("Unknown package operation");
    }
    respond(true, result, undefined);
    if (["validate", "adopt", "publish"].includes(method))
      void workPackageQueue(config).catch(() => {
        /* Durable jobs retain their own failure state. */
      });
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
  }
};
export const skillPackageHandlers: GatewayRequestHandlers = Object.fromEntries(
  [...PACKAGE_READ_METHODS, ...PACKAGE_WRITE_METHODS, ...PACKAGE_APPROVAL_METHODS].map((method) => [
    method,
    handler,
  ]),
);
