import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { KeyPair } from "../../../commerce/envelope.js";
import { canonicalJson, type JsonValue } from "../../../commerce/sku.js";
import {
  HashSchema,
  IdentitySchema,
  learningHash,
  lineageId,
  PACKAGE_LIMITS,
  sha256,
  type SkillRelease,
} from "./contracts.js";
import { validateManifest, verifySnapshot } from "./package.js";
import type { SkillPolicyService } from "./policy.js";
import { signRecord, validateRelease, verifyRecord } from "./signatures.js";
import type { CollectiveSkillStore } from "./store.js";

export const ObjectRequestSchema = z
  .object({
    releaseId: HashSchema,
    objectHash: HashSchema,
    offset: z.number().int().min(0).max(PACKAGE_LIMITS.bytes),
  })
  .strict();
export type ObjectRequest = z.infer<typeof ObjectRequestSchema>;
export type ObjectChunk = { objectHash: string; offset: number; total: number; data: string };
export interface PackageTransport {
  announce(release: SkillRelease, idempotencyKey: string): Promise<void>;
  fetch(request: ObjectRequest, signal: AbortSignal): Promise<ObjectChunk>;
  withdraw?(withdrawal: ReturnType<typeof createWithdrawal>): Promise<void>;
  evidence?(summary: import("./evidence.js").PeerEvidenceSummary): Promise<void>;
}

export class PackageDistribution {
  constructor(
    readonly store: CollectiveSkillStore,
    readonly policies: SkillPolicyService,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS collective_publications(release_id TEXT PRIMARY KEY, agent TEXT NOT NULL, policy_id TEXT NOT NULL)",
    );
  }
  async publish(agent: string, input: unknown, transport: PackageTransport): Promise<string> {
    const release = validateRelease(input);
    this.store.assertAncestry(release);
    const policy = this.policies.authorize(agent, release, "publish", "skill-package");
    this.store.assertDisclosure(release.packageHash, release.scope);
    if (this.store.get(release.packageHash)?.state !== "stable")
      throw new Error("Publication requires stable local execution evidence");
    await this.store.read(release.packageHash);
    const id = this.store.addRelease(release);
    this.store.transaction(() => {
      this.policies.authorize(agent, release, "publish", "skill-package");
      this.store.db
        .prepare("INSERT OR IGNORE INTO collective_publications VALUES (?,?,?)")
        .run(id, agent, policy.id);
      this.store.db
        .prepare("INSERT OR IGNORE INTO collective_deliveries VALUES (?,?,?,'pending',?)")
        .run(id, id, JSON.stringify(release.scope), this.store.now());
    });
    const state = this.store.db
      .prepare("SELECT state FROM collective_deliveries WHERE id=?")
      .get(id) as { state: string };
    if (state.state === "delivered") return id;
    try {
      this.policies.authorize(agent, release, "publish", "skill-package");
      await transport.announce(release, id);
      this.store.db
        .prepare("UPDATE collective_deliveries SET state='delivered',updated_at=? WHERE id=?")
        .run(this.store.now(), id);
    } catch (error) {
      this.store.db
        .prepare("UPDATE collective_deliveries SET state='uncertain',updated_at=? WHERE id=?")
        .run(this.store.now(), id);
      throw error;
    }
    return id;
  }
  /** requester identity is supplied by authenticated transport, never by request JSON. */
  async serve(input: unknown, requester: string, circleId?: string): Promise<ObjectChunk> {
    const request = ObjectRequestSchema.parse(input);
    const release = this.store.release(request.releaseId);
    const publication = this.store.db
      .prepare("SELECT agent FROM collective_publications WHERE release_id=?")
      .get(request.releaseId) as { agent: string } | undefined;
    if (!release || !publication) throw new Error("Package unavailable");
    this.policies.authorize(publication.agent, release, "publish", "skill-package");
    this.store.assertDisclosure(release.packageHash, release.scope);
    if (release.scope.kind === "private") throw new Error("Private package unavailable");
    if (
      release.scope.kind === "circle" &&
      (release.scope.circleId !== circleId || !this.policies.member(circleId, requester))
    )
      throw new Error("Circle object access denied");
    if (release.scope.kind === "public" && circleId !== undefined)
      throw new Error("Wrong serving scope");
    const snapshot = await this.store.read(release.packageHash);
    let bytes =
      request.objectHash === release.packageHash
        ? Buffer.from(canonicalJson(snapshot.manifest as unknown as JsonValue))
        : [...snapshot.files].find(
            ([name]) =>
              snapshot.manifest.files.find((f) => f.path === name)?.hash === request.objectHash,
          )?.[1];
    if (!bytes) {
      let ancestor = release.previousRelease;
      for (let depth = 0; ancestor && depth < 128; depth++) {
        const row = this.store.db
          .prepare("SELECT body FROM collective_releases WHERE id=?")
          .get(ancestor) as { body: string } | undefined;
        if (!row) break;
        const prior = validateRelease(JSON.parse(row.body));
        if (
          lineageId(prior) !== lineageId(release) ||
          learningHash(prior.scope) !== learningHash(release.scope)
        )
          break;
        if (ancestor === request.objectHash) {
          bytes = Buffer.from(canonicalJson(prior as unknown as JsonValue));
          break;
        }
        ancestor = prior.previousRelease;
      }
    }
    if (!bytes || request.offset > bytes.length || request.offset % PACKAGE_LIMITS.chunk !== 0)
      throw new Error("Invalid package object range");
    // Recheck after asynchronous disk access to honor a concurrent grant revocation.
    this.policies.authorize(publication.agent, release, "publish", "skill-package");
    if (release.scope.kind === "circle" && !this.policies.member(release.scope.circleId, requester))
      throw new Error("Membership revoked");
    return {
      objectHash: request.objectHash,
      offset: request.offset,
      total: bytes.length,
      data: bytes
        .subarray(request.offset, request.offset + PACKAGE_LIMITS.chunk)
        .toString("base64"),
    };
  }
}

/** Content is persisted only under generated hash paths, with a separate partial per release. */
export async function receivePackage(
  store: CollectiveSkillStore,
  input: unknown,
  transport: PackageTransport,
  authorize: (release: SkillRelease) => void,
  signal: AbortSignal,
): Promise<string> {
  const release = validateRelease(input);
  const releaseId = learningHash(release);
  const directory = path.join(store.root, "downloads", releaseId);
  authorize(release);
  const downloads = path.dirname(directory);
  await fs.mkdir(downloads, { recursive: true });
  const pending = await fs.readdir(downloads);
  if (!pending.includes(releaseId) && pending.length >= 32)
    throw new Error("Download quota reached; resolve existing partial downloads");
  await fs.mkdir(directory, { recursive: true });
  async function object(hash: string, expectedSize?: number): Promise<Buffer> {
    HashSchema.parse(hash);
    const filename = path.join(directory, hash);
    const stat = await fs.lstat(filename).catch(() => null);
    if (
      stat &&
      (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > PACKAGE_LIMITS.bytes)
    )
      throw new Error("Invalid download cache");
    let bytes = stat ? await fs.readFile(filename) : Buffer.alloc(0);
    if (sha256(bytes) === hash && (expectedSize === undefined || bytes.length === expectedSize))
      return bytes;
    if (bytes.length % PACKAGE_LIMITS.chunk !== 0) {
      bytes = Buffer.alloc(0);
      await fs.writeFile(filename, bytes);
    }
    let total: number | undefined = expectedSize;
    while (total === undefined || bytes.length < total || !bytes.length) {
      signal.throwIfAborted();
      authorize(release);
      const response = await transport.fetch(
        { releaseId, objectHash: hash, offset: bytes.length },
        AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      );
      authorize(release);
      if (
        response.objectHash !== hash ||
        response.offset !== bytes.length ||
        !Number.isInteger(response.total) ||
        response.total < 0 ||
        response.total > (expectedSize === undefined ? 65536 : PACKAGE_LIMITS.bytes) ||
        (total !== undefined && response.total !== total) ||
        response.data.length > Math.ceil(PACKAGE_LIMITS.chunk / 3) * 4
      )
        throw new Error("Invalid package chunk");
      const chunk = Buffer.from(response.data, "base64");
      if (
        chunk.toString("base64") !== response.data ||
        chunk.length !== Math.min(PACKAGE_LIMITS.chunk, response.total - bytes.length)
      )
        throw new Error("Invalid chunk encoding or size");
      total = response.total;
      bytes = Buffer.concat([bytes, chunk]);
      await fs.writeFile(filename, bytes, { mode: 0o600 });
      if (!chunk.length) break;
    }
    if (bytes.length !== total || sha256(bytes) !== hash) {
      await fs.rm(filename, { force: true });
      throw new Error("Downloaded object hash mismatch");
    }
    return bytes;
  }
  const manifest = validateManifest(
    JSON.parse((await object(release.packageHash)).toString("utf8")),
  );
  if (
    release.requirementsSummary &&
    learningHash(release.requirementsSummary) !== learningHash(manifest.requirements)
  )
    throw new Error("Announced requirements do not match package");
  let ancestor = release.previousRelease;
  for (let depth = 0; ancestor; depth++) {
    if (depth >= 128) throw new Error("Release history exceeds supported bound");
    const row = store.db
      .prepare("SELECT body FROM collective_releases WHERE id=?")
      .get(ancestor) as { body: string } | undefined;
    const prior = row
      ? validateRelease(JSON.parse(row.body))
      : validateRelease(JSON.parse((await object(ancestor)).toString("utf8")));
    store.addRelease(prior);
    ancestor = prior.previousRelease;
  }
  store.assertAncestry(release);
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) files.set(file.path, await object(file.hash, file.size));
  const snapshot = { packageHash: release.packageHash, manifest, files, omitted: [] };
  verifySnapshot(snapshot);
  authorize(release);
  await store.install(snapshot);
  store.recordOrigin(snapshot.packageHash, release.scope);
  authorize(release);
  store.addRelease(release);
  if (
    !store.db
      .prepare("SELECT 1 FROM collective_audit WHERE kind='package-received' AND subject=?")
      .get(releaseId)
  )
    store.audit("package-received", releaseId);
  await fs.rm(directory, { recursive: true, force: true });
  return releaseId;
}

const WithdrawalSchema = z
  .object({
    protocol: z.literal("bitterbot/skill-withdrawal/1"),
    releaseId: HashSchema,
    publisher: IdentitySchema,
    issuedAt: z.number().int().positive(),
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export function withdrawRelease(store: CollectiveSkillStore, input: unknown): void {
  const withdrawal = WithdrawalSchema.parse(input);
  const row = store.db
    .prepare("SELECT body FROM collective_releases WHERE id=?")
    .get(withdrawal.releaseId) as { body: string } | undefined;
  const release = row ? validateRelease(JSON.parse(row.body)) : null;
  if (
    !release ||
    release.publisher !== withdrawal.publisher ||
    !verifyRecord(withdrawal.protocol, withdrawal, withdrawal.publisher)
  )
    throw new Error("Withdrawal is not authorized by publisher");
  store.transaction(() => {
    store.db
      .prepare("UPDATE collective_releases SET withdrawn=1 WHERE id=?")
      .run(withdrawal.releaseId);
    const descendants = store.db
      .prepare("SELECT hash FROM collective_proposal_authority WHERE source_release=?")
      .all(withdrawal.releaseId) as { hash: string }[];
    for (const descendant of descendants) store.state(descendant.hash, "stale", "parent-withdrawn");
    const affected = store.db
      .prepare("SELECT agent FROM collective_active WHERE lineage=? AND hash=?")
      .all(lineageId(release), release.packageHash) as { agent: string }[];
    for (const active of affected)
      store.rollback(
        active.agent,
        lineageId(release),
        store.get(release.packageHash)?.environment ?? "",
        "publisher-withdrawal",
      );
    if (
      affected.length &&
      !store.db.prepare("SELECT 1 FROM collective_active WHERE hash=?").get(release.packageHash)
    )
      store.state(release.packageHash, "revoked", "publisher-withdrawal");
    store.audit("withdrawn", withdrawal.releaseId);
  });
}
export function createWithdrawal(releaseId: string, key: KeyPair, issuedAt = Date.now()) {
  return signRecord(
    "bitterbot/skill-withdrawal/1",
    {
      protocol: "bitterbot/skill-withdrawal/1" as const,
      releaseId,
      publisher: `ed25519:${key.publicKeyHex}`,
      issuedAt,
    },
    key,
  );
}
