import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ComputeDescriptor } from "./mesh-protocol.js";

export type MeshGrant = {
  peerId: string;
  pubkey: string;
  principal: string;
  token: string;
  pools: string[];
  projects: string[];
  enabled: boolean;
};
export type MeshBatch = {
  id: string;
  intent: string;
  createdAt: number;
  status: "running" | "succeeded" | "failed" | "cancelling" | "cancelled";
  mode: "private" | "collective";
  scope: string;
  kind: "sha256" | "embeddings";
  model?: string;
  digest?: string;
  inputs: string[];
  result: unknown;
  peers: string[];
  shards: Array<{
    index: number;
    offset: number;
    count: number;
    peerId: string;
    jobId?: string;
    status: string;
    attempts: number;
    error?: string;
    result?: unknown;
    failures?: number;
    lastTriedAt?: number;
  }>;
};
export class ComputeMeshStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mesh_peers(peer TEXT PRIMARY KEY,issued INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_grants(peer TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_batches(id TEXT PRIMARY KEY,intent TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_activity(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,peer TEXT,kind TEXT NOT NULL,items INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_outcomes(job TEXT PRIMARY KEY,peer TEXT NOT NULL,ok INTEGER NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_remote_jobs(job TEXT PRIMARY KEY,peer TEXT NOT NULL,status TEXT NOT NULL,items INTEGER NOT NULL);
    `);
  }
  peer(d: ComputeDescriptor): void {
    this.db.prepare("DELETE FROM mesh_peers WHERE expires<=?").run(Date.now());
    const count = this.db.prepare("SELECT count(*) n FROM mesh_peers").get() as { n: number };
    if (count.n >= 512 && !this.db.prepare("SELECT 1 FROM mesh_peers WHERE peer=?").get(d.peerId))
      return;
    this.db
      .prepare(
        `INSERT INTO mesh_peers VALUES(?,?,?,?) ON CONFLICT(peer) DO UPDATE SET issued=excluded.issued,expires=excluded.expires,data=excluded.data WHERE excluded.issued>mesh_peers.issued`,
      )
      .run(d.peerId, d.issuedAt, d.expiresAt, JSON.stringify(d));
  }
  peers(now = Date.now()): ComputeDescriptor[] {
    this.db.prepare("DELETE FROM mesh_peers WHERE expires<=?").run(now);
    return this.db
      .prepare("SELECT data FROM mesh_peers ORDER BY peer")
      .all()
      .map((r) => JSON.parse(String(r.data)) as ComputeDescriptor);
  }
  grant(peer: string): MeshGrant | undefined {
    const row = this.db.prepare("SELECT data FROM mesh_grants WHERE peer=?").get(peer);
    return row ? (JSON.parse(String(row.data)) as MeshGrant) : undefined;
  }
  saveGrant(grant: MeshGrant): void {
    this.db
      .prepare(
        "INSERT INTO mesh_grants VALUES(?,?) ON CONFLICT(peer) DO UPDATE SET data=excluded.data",
      )
      .run(grant.peerId, JSON.stringify(grant));
  }
  revoke(peer: string): void {
    this.db.prepare("DELETE FROM mesh_grants WHERE peer=?").run(peer);
  }
  grants(): string[] {
    return this.db
      .prepare("SELECT peer FROM mesh_grants WHERE json_extract(data,'$.enabled')=1")
      .all()
      .map((r) => String(r.peer));
  }
  permissions(): Array<{ peerId: string; enabled: boolean; pools: string[]; projects: string[] }> {
    return this.db
      .prepare("SELECT data FROM mesh_grants")
      .all()
      .map((row) => {
        const g = JSON.parse(String(row.data)) as MeshGrant;
        return { peerId: g.peerId, enabled: g.enabled, pools: g.pools, projects: g.projects };
      });
  }
  saveBatch(batch: MeshBatch): void {
    this.db
      .prepare(
        "INSERT INTO mesh_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(batch.id, batch.intent, JSON.stringify(batch));
  }
  batches(): MeshBatch[] {
    return this.db
      .prepare("SELECT data FROM mesh_batches ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((r) => JSON.parse(String(r.data)) as MeshBatch);
  }
  active(): MeshBatch[] {
    return this.db
      .prepare(
        "SELECT data FROM mesh_batches WHERE json_extract(data,'$.status') IN ('running','cancelling')",
      )
      .all()
      .map((r) => JSON.parse(String(r.data)) as MeshBatch);
  }
  batch(id: string): MeshBatch | undefined {
    const r = this.db.prepare("SELECT data FROM mesh_batches WHERE id=? OR intent=?").get(id, id);
    return r ? (JSON.parse(String(r.data)) as MeshBatch) : undefined;
  }
  activity(peer: string, kind: string, items = 0): void {
    this.db
      .prepare("INSERT INTO mesh_activity(at,peer,kind,items) VALUES(?,?,?,?)")
      .run(Date.now(), peer, kind, items);
    this.db.exec("DELETE FROM mesh_activity WHERE id < (SELECT MAX(id)-1000 FROM mesh_activity)");
  }
  recent(): Array<{ at: number; peer: string; kind: string; items: number }> {
    return this.db
      .prepare("SELECT at,peer,kind,items FROM mesh_activity ORDER BY id DESC LIMIT 30")
      .all() as Array<{ at: number; peer: string; kind: string; items: number }>;
  }
  remoteJob(job: string, peer: string, status: string, items: number): void {
    const old = this.db.prepare("SELECT status FROM mesh_remote_jobs WHERE job=?").get(job);
    if (old?.status === status) return;
    this.db
      .prepare(
        "INSERT INTO mesh_remote_jobs VALUES(?,?,?,?) ON CONFLICT(job) DO UPDATE SET status=excluded.status",
      )
      .run(job, peer, status, items);
    this.activity(peer, `incoming_${status}`, items);
    this.db.exec(
      "DELETE FROM mesh_remote_jobs WHERE rowid < (SELECT MAX(rowid)-1000 FROM mesh_remote_jobs) AND status IN ('succeeded','failed','cancelled')",
    );
  }
  outcome(job: string, peer: string, ok: boolean): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO mesh_outcomes VALUES(?,?,?,?)")
        .run(job, peer, ok ? 1 : 0, Date.now()).changes > 0
    );
  }
  reliability(peer: string): number {
    const r = this.db
      .prepare("SELECT count(*) n,COALESCE(sum(ok),0) ok FROM mesh_outcomes WHERE peer=?")
      .get(peer) as { n: number; ok: number };
    return (r.ok + 1) / (r.n + 2);
  }
  close(): void {
    this.db.close();
  }
}
