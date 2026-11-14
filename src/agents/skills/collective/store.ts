import crypto from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  HashSchema,
  learningHash,
  lineageId,
  type PackageSnapshot,
  type PackageState,
  type SkillRelease,
  type SkillPackageManifest,
} from "./contracts.js";
import { screenPackage, validateManifest, verifySnapshot } from "./package.js";
import { validateRelease } from "./signatures.js";

export type PackageRecord = {
  hash: string;
  manifest: SkillPackageManifest;
  state: PackageState;
  reason: string | null;
  environment: string | null;
};
export type ActivePackage = {
  agent: string;
  lineage: string;
  hash: string;
  previous: string | null;
  pinned: boolean;
  customized: boolean;
};

/** Dedicated additive tables. The filesystem is immutable; SQLite commits visibility. */
export class CollectiveSkillStore {
  constructor(
    readonly db: DatabaseSync,
    readonly root: string,
    readonly now = Date.now,
  ) {
    mkdirSync(root, { recursive: true });
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Package store root must be a real directory");
    // Resolve host-selected ancestors before comparing immutable child paths.
    this.root = realpathSync(root);
    db.exec(`
      CREATE TABLE IF NOT EXISTS collective_packages(hash TEXT PRIMARY KEY, manifest TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, environment TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_releases(id TEXT PRIMARY KEY, lineage TEXT NOT NULL, version INTEGER NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(lineage,version,scope));
      CREATE TABLE IF NOT EXISTS collective_active(agent TEXT NOT NULL, lineage TEXT NOT NULL, hash TEXT NOT NULL, previous TEXT, pinned INTEGER NOT NULL DEFAULT 0, customized INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent,lineage));
      CREATE TABLE IF NOT EXISTS collective_audit(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_jobs(id TEXT PRIMARY KEY, lineage TEXT NOT NULL, hash TEXT NOT NULL, environment TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, verdict TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_trials(job TEXT NOT NULL, task_hash TEXT NOT NULL, partition TEXT NOT NULL, body TEXT, PRIMARY KEY(job,task_hash));
      CREATE TABLE IF NOT EXISTS collective_receipts(id TEXT PRIMARY KEY, hash TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_canary(agent TEXT NOT NULL, lineage TEXT NOT NULL, hash TEXT NOT NULL, started_at INTEGER NOT NULL, PRIMARY KEY(agent,lineage));
      CREATE TABLE IF NOT EXISTS collective_canary_runs(agent TEXT NOT NULL, lineage TEXT NOT NULL, run TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(agent,lineage,run));
      CREATE TABLE IF NOT EXISTS collective_policies(id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_deliveries(id TEXT PRIMARY KEY, release TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_evidence(id TEXT PRIMARY KEY, origin TEXT NOT NULL, execution TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(origin,execution));
      CREATE TABLE IF NOT EXISTS collective_proposals(lineage TEXT NOT NULL, day INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(lineage,day));
      CREATE TABLE IF NOT EXISTS collective_origins(hash TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(hash,scope));
      CREATE TABLE IF NOT EXISTS collective_disclosures(hash TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(hash,scope));
      CREATE TABLE IF NOT EXISTS collective_proposal_authority(hash TEXT PRIMARY KEY, source_release TEXT NOT NULL, mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collective_pins(agent TEXT NOT NULL, run TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(agent,run));
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT collective_change");
    try {
      const result = fn();
      this.db.exec("RELEASE collective_change");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO collective_change; RELEASE collective_change");
      throw error;
    }
  }
  audit(kind: string, subject: string, body: unknown = {}): void {
    this.db
      .prepare("INSERT INTO collective_audit(kind,subject,body,at) VALUES (?,?,?,?)")
      .run(kind, subject, JSON.stringify(body), this.now());
  }
  recordOrigin(hash: string, scope: unknown): void {
    HashSchema.parse(hash);
    this.db
      .prepare("INSERT OR IGNORE INTO collective_origins VALUES (?,?)")
      .run(hash, JSON.stringify(scope));
  }
  inheritOrigins(hash: string, parent: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO collective_origins SELECT ?,scope FROM collective_origins WHERE hash=?",
      )
      .run(hash, parent);
  }
  assertDisclosure(hash: string, scope: SkillRelease["scope"]): void {
    const origins = this.db
      .prepare("SELECT scope FROM collective_origins WHERE hash=?")
      .all(hash) as { scope: string }[];
    if (
      origins.some((o) => {
        const source = JSON.parse(o.scope) as SkillRelease["scope"];
        return source.kind === "circle" && learningHash(source) !== learningHash(scope);
      }) &&
      !this.db
        .prepare("SELECT 1 FROM collective_disclosures WHERE hash=? AND scope=?")
        .get(hash, JSON.stringify(scope))
    )
      throw new Error("Explicit disclosure approval required for Circle-derived package");
  }
  directory(hash: string): string {
    HashSchema.parse(hash);
    return path.join(this.root, "packages", hash);
  }
  async install(snapshot: PackageSnapshot): Promise<PackageRecord> {
    verifySnapshot(snapshot);
    if (!this.get(snapshot.packageHash)) {
      const usage = this.db
        .prepare(
          "SELECT COUNT(DISTINCT hash) AS packages, COALESCE(SUM(json_extract(value,'$.size')),0) AS bytes FROM collective_packages,json_each(manifest,'$.files')",
        )
        .get() as { packages: number; bytes: number };
      if (
        usage.packages >= 1000 ||
        usage.bytes + snapshot.manifest.files.reduce((n, f) => n + f.size, 0) > 1024 ** 3
      )
        throw new Error("Package storage quota exceeded");
    }
    // Copy the validated bytes so asynchronous installation cannot observe caller mutation.
    const frozen: PackageSnapshot = {
      ...snapshot,
      manifest: structuredClone(snapshot.manifest),
      files: new Map([...snapshot.files].map(([n, b]) => [n, Buffer.from(b)])),
    };
    const destination = this.directory(frozen.packageHash);
    const temporary = path.join(this.root, "staging", crypto.randomUUID());
    await fs.mkdir(temporary, { recursive: true });
    try {
      for (const file of frozen.manifest.files) {
        const target = path.join(temporary, "content", file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, frozen.files.get(file.path)!, {
          flag: "wx",
          mode: file.executable ? 0o500 : 0o400,
        });
      }
      await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(frozen.manifest), {
        flag: "wx",
        mode: 0o400,
      });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if (!(await fs.stat(destination).catch(() => null))?.isDirectory()) throw error;
        await this.read(frozen.packageHash);
      }
      this.db
        .prepare("INSERT OR IGNORE INTO collective_packages VALUES (?,?, 'candidate',NULL,NULL,?)")
        .run(frozen.packageHash, JSON.stringify(frozen.manifest), this.now());
      this.audit("package-staged", frozen.packageHash, { omitted: frozen.omitted });
      return this.get(frozen.packageHash)!;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  async read(hash: string): Promise<PackageSnapshot> {
    const directory = this.directory(hash);
    const manifestPath = path.join(directory, "manifest.json"),
      stat = await fs.lstat(manifestPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 65536 ||
      (await fs.realpath(manifestPath)) !== manifestPath
    )
      throw new Error("Invalid stored manifest");
    const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    const files = new Map<string, Buffer>();
    for (const file of manifest.files) {
      const filename = path.join(directory, "content", file.path);
      const stat = await fs.lstat(filename);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== file.size ||
        (await fs.realpath(filename)) !== filename
      )
        throw new Error("Stored package was modified");
      files.set(file.path, await fs.readFile(filename));
    }
    const result = { packageHash: hash, manifest, files, omitted: [] };
    verifySnapshot(result);
    return result;
  }
  get(hash: string): PackageRecord | null {
    const row = this.db.prepare("SELECT * FROM collective_packages WHERE hash=?").get(hash) as
      | (Omit<PackageRecord, "manifest"> & { manifest: string })
      | undefined;
    return row ? { ...row, manifest: validateManifest(JSON.parse(row.manifest)) } : null;
  }
  list(): PackageRecord[] {
    return (
      this.db
        .prepare("SELECT hash FROM collective_packages ORDER BY created_at DESC LIMIT 500")
        .all() as { hash: string }[]
    ).map((r) => this.get(r.hash)!);
  }
  state(
    hash: string,
    state: PackageState,
    reason: string | null = null,
    environment: string | null = null,
  ): void {
    if (!this.get(hash)) throw new Error("Unknown package");
    this.db
      .prepare(
        "UPDATE collective_packages SET state=?,reason=?,environment=COALESCE(?,environment) WHERE hash=?",
      )
      .run(state, reason, environment, hash);
    this.audit(`package-${state}`, hash, { reason });
  }
  async screen(hash: string): Promise<void> {
    try {
      screenPackage(await this.read(hash));
      this.state(hash, "screened");
    } catch (error) {
      this.state(hash, "blocked", String(error));
      throw error;
    }
  }
  addRelease(input: unknown): string {
    const release = validateRelease(input);
    const id = learningHash(release);
    const existing = this.db
      .prepare("SELECT id FROM collective_releases WHERE lineage=? AND version=? AND scope=?")
      .get(lineageId(release), release.version, JSON.stringify(release.scope)) as
      | { id: string }
      | undefined;
    if (existing && existing.id !== id) throw new Error("Release equivocation");
    if (release.previousRelease) {
      const previousRow = this.db
        .prepare("SELECT body FROM collective_releases WHERE id=?")
        .get(release.previousRelease) as { body: string } | undefined;
      const prior = previousRow ? validateRelease(JSON.parse(previousRow.body)) : null;
      if (
        prior &&
        (lineageId(prior) !== lineageId(release) ||
          prior.version + 1 !== release.version ||
          learningHash(prior.scope) !== learningHash(release.scope))
      )
        throw new Error("Conflicting release ancestry");
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO collective_releases(id,lineage,version,scope,hash,body) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        lineageId(release),
        release.version,
        JSON.stringify(release.scope),
        release.packageHash,
        JSON.stringify(release),
      );
    return id;
  }
  release(id: string): SkillRelease | null {
    const row = this.db
      .prepare("SELECT body FROM collective_releases WHERE id=? AND withdrawn=0")
      .get(id) as { body: string } | undefined;
    return row ? validateRelease(JSON.parse(row.body)) : null;
  }
  assertAncestry(release: SkillRelease): void {
    let current = release;
    for (let depth = 0; current.previousRelease; depth++) {
      if (depth >= 128) throw new Error("Release history exceeds supported bound");
      const row = this.db
        .prepare("SELECT body FROM collective_releases WHERE id=?")
        .get(current.previousRelease) as { body: string } | undefined;
      const prior = row ? validateRelease(JSON.parse(row.body)) : null;
      if (
        !prior ||
        learningHash(prior) !== current.previousRelease ||
        lineageId(prior) !== lineageId(current) ||
        prior.version + 1 !== current.version ||
        learningHash(prior.scope) !== learningHash(current.scope)
      )
        throw new Error("Incomplete release history");
      current = prior;
    }
  }
  active(agent: string, lineage: string): ActivePackage | null {
    const row = this.db
      .prepare("SELECT * FROM collective_active WHERE agent=? AND lineage=?")
      .get(agent, lineage) as
      | (Omit<ActivePackage, "pinned" | "customized"> & { pinned: number; customized: number })
      | undefined;
    return row
      ? { ...row, pinned: Boolean(row.pinned), customized: Boolean(row.customized) }
      : null;
  }
  activate(
    agent: string,
    release: SkillRelease,
    environment: string,
    localAdaptationOf?: string,
  ): void {
    this.assertAncestry(release);
    this.transaction(() => {
      const pkg = this.get(release.packageHash);
      if (
        !pkg ||
        !["locally-validated", "canary", "stable"].includes(pkg.state) ||
        pkg.environment !== environment
      )
        throw new Error("Package lacks current local validation");
      const lineage = localAdaptationOf ?? lineageId(release);
      const old = this.active(agent, lineage);
      if (old?.hash === pkg.hash) return;
      if (old?.pinned || old?.customized) throw new Error("Local version is pinned or customized");
      this.db
        .prepare(
          "INSERT INTO collective_active VALUES (?,?,?,?,0,0) ON CONFLICT(agent,lineage) DO UPDATE SET hash=excluded.hash,previous=excluded.previous",
        )
        .run(agent, lineage, pkg.hash, old?.hash ?? null);
      if (localAdaptationOf)
        this.db
          .prepare("UPDATE collective_active SET customized=1 WHERE agent=? AND lineage=?")
          .run(agent, lineage);
      this.db
        .prepare("INSERT OR REPLACE INTO collective_canary VALUES (?,?,?,?)")
        .run(agent, lineage, pkg.hash, this.now());
      this.state(pkg.hash, "canary");
      this.audit("activated", pkg.hash, { agent, lineage, previous: old?.hash ?? null });
    });
  }
  rollback(agent: string, lineage: string, environment: string, reason: string): void {
    const started = performance.now();
    this.transaction(() => {
      const active = this.active(agent, lineage);
      if (!active) return;
      const previous = active.previous && this.get(active.previous);
      const compatible = Boolean(
        previous &&
        previous.environment === environment &&
        ["stable", "locally-validated", "canary"].includes(previous.state),
      );
      if (compatible && previous)
        this.db
          .prepare("UPDATE collective_active SET hash=?,previous=NULL WHERE agent=? AND lineage=?")
          .run(previous.hash, agent, lineage);
      else
        this.db
          .prepare("DELETE FROM collective_active WHERE agent=? AND lineage=?")
          .run(agent, lineage);
      this.db
        .prepare("DELETE FROM collective_canary WHERE agent=? AND lineage=?")
        .run(agent, lineage);
      this.state(active.hash, "rolled-back", reason);
      this.audit("rollback", active.hash, {
        agent,
        lineage,
        restored: compatible && previous ? previous.hash : null,
        reason,
        latencyMs: performance.now() - started,
      });
    });
  }
  pin(agent: string, lineage: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE collective_active SET pinned=? WHERE agent=? AND lineage=?")
      .run(Number(pinned), agent, lineage);
  }
}
