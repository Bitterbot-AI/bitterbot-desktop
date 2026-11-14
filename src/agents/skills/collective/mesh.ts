import type { BitterbotConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import type { OrchestratorBridge } from "../../../infra/orchestrator-bridge.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { learningHash, type SkillRelease } from "./contracts.js";
import { PeerEvidenceSchema } from "./evidence.js";
import { getCollectiveRuntime, type CollectiveRuntime } from "./runtime.js";
import { validateRelease } from "./signatures.js";
import type { ObjectChunk, PackageTransport } from "./transport.js";
import { withdrawRelease } from "./transport.js";

export const PACKAGE_TOPIC = "bitterbot/packages/v1";
const log = createSubsystemLogger("skills/packages/mesh");
let active: PackageMesh | null = null;
export function getPackageMesh(): PackageMesh | null {
  return active;
}
export class PackageMesh {
  private unsub: (() => void) | undefined;
  private readonly rates = new Map<string, { at: number; count: number }>();
  constructor(
    readonly bridge: OrchestratorBridge,
    readonly runtime: CollectiveRuntime,
    readonly enabled: () => boolean,
  ) {
    runtime.store.db.exec(
      "CREATE TABLE IF NOT EXISTS collective_sources(release_id TEXT NOT NULL, peer TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(release_id,peer))",
    );
  }
  private allow(peer: string): void {
    if (!this.enabled()) throw new Error("Public package mesh disabled");
    const now = Date.now(),
      old = this.rates.get(peer);
    if (old && now - old.at < 60000) {
      if (++old.count > 512) throw new Error("Package request rate limited");
    } else {
      if (this.rates.size >= 1024) {
        for (const [key, value] of this.rates) if (now - value.at >= 60000) this.rates.delete(key);
        if (this.rates.size >= 1024) throw new Error("Package peer capacity reached");
      }
      this.rates.set(peer, { at: now, count: 1 });
    }
  }
  async start(): Promise<void> {
    await this.bridge.subscribeCircleTopic(PACKAGE_TOPIC);
    this.unsub = this.bridge.onCircleTopicMessage((event) => {
      if (event.topic !== PACKAGE_TOPIC) return;
      try {
        this.allow(event.from_peer_id);
        if (event.data_b64.length > 24000) throw new Error("Announcement too large");
        const decoded = JSON.parse(Buffer.from(event.data_b64, "base64").toString("utf8")) as {
          type?: string;
          body?: unknown;
        };
        if (decoded.type === "withdrawal") {
          const id = (decoded.body as { releaseId?: string })?.releaseId;
          if (!id || this.runtime.store.release(id)?.scope.kind !== "public") return;
          withdrawRelease(this.runtime.store, decoded.body);
          return;
        }
        if (decoded.type === "evidence") {
          const evidence = PeerEvidenceSchema.parse(decoded.body);
          if (evidence.scope.kind !== "public") throw new Error("Private evidence on public topic");
          this.runtime.evidence.import(evidence);
          return;
        }
        const release = validateRelease(decoded);
        if (release.scope.kind !== "public") throw new Error("Nonpublic release on public topic");
        const count = this.runtime.store.db
          .prepare("SELECT COUNT(*) AS n FROM collective_releases")
          .get() as { n: number };
        if (count.n >= 10000 && !this.runtime.store.release(learningHash(release)))
          throw new Error("Catalog capacity reached");
        const id = this.runtime.store.addRelease(release);
        this.runtime.store.db
          .prepare(
            "INSERT INTO collective_sources VALUES (?,?,?) ON CONFLICT(release_id,peer) DO UPDATE SET seen_at=excluded.seen_at",
          )
          .run(id, event.from_peer_id, Date.now());
      } catch (error) {
        log.debug(`Package announcement ignored: ${String(error)}`);
      }
    });
  }
  async stop(): Promise<void> {
    this.unsub?.();
    await this.bridge.unsubscribeCircleTopic(PACKAGE_TOPIC);
    if (active === this) active = null;
  }
  async handle(peer: string, method: string, params: unknown): Promise<unknown> {
    try {
      this.allow(peer);
      if (method === "skill-package/1/capabilities")
        return { ok: true, result: { version: 1, chunkBytes: 24576 } };
      if (method !== "skill-package/1/object") throw new Error("Unsupported package method");
      return { ok: true, result: await this.runtime.distribution.serve(params, peer) };
    } catch (error) {
      return { ok: false, error: String(error), refused: true };
    }
  }
  transport(release: SkillRelease): PackageTransport {
    const releaseId = learningHash(release);
    return {
      withdraw: async (body) => {
        if (!this.enabled() || release.scope.kind !== "public")
          throw new Error("Public mesh disabled");
        await this.bridge.publishCircleTopic(
          PACKAGE_TOPIC,
          Buffer.from(JSON.stringify({ type: "withdrawal", body })).toString("base64"),
        );
      },
      evidence: async (body) => {
        if (!this.enabled() || body.scope.kind !== "public")
          throw new Error("Evidence scope mismatch");
        await this.bridge.publishCircleTopic(
          PACKAGE_TOPIC,
          Buffer.from(JSON.stringify({ type: "evidence", body })).toString("base64"),
        );
      },
      announce: async (value) => {
        if (!this.enabled() || value.scope.kind !== "public")
          throw new Error("Public publication not enabled");
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > 16384) throw new Error("Announcement too large");
        await this.bridge.publishCircleTopic(PACKAGE_TOPIC, bytes.toString("base64"));
      },
      fetch: async (request, signal) => {
        signal.throwIfAborted();
        if (!this.enabled()) throw new Error("Public mesh disabled");
        const sources = this.runtime.store.db
          .prepare(
            "SELECT peer FROM collective_sources WHERE release_id=? ORDER BY seen_at DESC LIMIT 3",
          )
          .all(releaseId) as { peer: string }[];
        for (const source of sources) {
          signal.throwIfAborted();
          try {
            return await this.bridge.requestPackageObject(source.peer, request);
          } catch {
            /* Try another observed source; never downgrade to legacy skill gossip. */
          }
        }
        throw new Error("No compatible reachable package source");
      },
    };
  }
}
export async function startPackageMesh(
  bridge: OrchestratorBridge,
  config: BitterbotConfig,
): Promise<PackageMesh | undefined> {
  const runtime = getCollectiveRuntime(config);
  if (!runtime || !config.skills?.collective?.publicMesh) return undefined;
  const mesh = new PackageMesh(bridge, runtime, () => {
    const cfg = loadConfig();
    return !!cfg.skills?.collective?.enabled && !!cfg.skills.collective.publicMesh;
  });
  await mesh.start();
  active = mesh;
  return mesh;
}
export type { ObjectChunk };
