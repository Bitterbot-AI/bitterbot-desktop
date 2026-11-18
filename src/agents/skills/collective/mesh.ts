import type { BitterbotConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import type { OrchestratorBridge } from "../../../infra/orchestrator-bridge.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { ownSkillCards, skillCardKey, storePeerSkillCards } from "../skill-cards-runtime.js";
import { loadSkillPriorLedger } from "../skill-prior-runtime.js";
import { resolveSkillPriorPeerEvidence } from "../skill-prior.js";
import { learningHash, type SkillRelease } from "./contracts.js";
import { PeerEvidenceSchema } from "./evidence.js";
import { getCollectiveRuntime, type CollectiveRuntime } from "./runtime.js";
import { validateRelease } from "./signatures.js";
import type { ObjectChunk, PackageTransport } from "./transport.js";
import { withdrawRelease } from "./transport.js";

export const PACKAGE_TOPIC = "bitterbot/packages/v1";
/** First card publication after start, then the check interval and the unchanged-bundle refresh. */
const CARDS_FIRST_MS = 2 * 60_000;
const CARDS_CHECK_MS = 60 * 60_000;
const CARDS_REFRESH_MS = 6 * 60 * 60_000;
const log = createSubsystemLogger("skills/packages/mesh");
let active: PackageMesh | null = null;
export function getPackageMesh(): PackageMesh | null {
  return active;
}
export class PackageMesh {
  private unsub: (() => void) | undefined;
  private readonly rates = new Map<string, { at: number; count: number }>();
  private cardTimers: NodeJS.Timeout[] = [];
  private selfOrigin: string | undefined;
  private lastCards: { digest: string; at: number } | null = null;
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
  private async publish(dataB64: string): Promise<void> {
    const sent = (await this.bridge.publishCircleTopic(PACKAGE_TOPIC, dataB64)) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (sent?.ok !== true)
      throw new Error(`Package topic publish refused: ${sent?.error ?? "no reply"}`);
  }
  async start(): Promise<void> {
    // A sidecar older than 0.2.5 refuses this topic with an ok:false reply
    // rather than an error, which would otherwise leave the mesh silently dead.
    const subscribed = (await this.bridge.subscribeCircleTopic(PACKAGE_TOPIC)) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (subscribed?.ok !== true)
      throw new Error(
        `the orchestrator refused the package topic (${subscribed?.error ?? "no reply"}); packages and skill cards need orchestrator 0.2.5 or newer`,
      );
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
        if (decoded.type === "cards") {
          // Verified outcome counts by skill content hash. Kept only when well
          // formed and signed; the guard and the quorum decide what is shown.
          const cfg = loadConfig();
          if (!resolveSkillPriorPeerEvidence(cfg.skills?.prior)) return;
          this.selfOrigin ??= `ed25519:${skillCardKey().publicKeyHex}`;
          const res = storePeerSkillCards(cfg, decoded.body, {
            now: Date.now(),
            self: this.selfOrigin,
          });
          if (!res.stored) log.debug(`Skill cards ignored: ${res.reason}`);
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
    this.scheduleCards();
  }
  /**
   * Announce this node's verified outcome counts (content hashes and counts
   * only). Skipped when the mesh or peer evidence is off, when nothing is
   * verified, or when an unchanged bundle was announced recently.
   */
  async publishCards(now = Date.now()): Promise<boolean> {
    if (!this.enabled()) return false;
    const cfg = loadConfig();
    if (!resolveSkillPriorPeerEvidence(cfg.skills?.prior)) return false;
    const bundle = ownSkillCards(loadSkillPriorLedger(cfg), skillCardKey(), now);
    if (!bundle) return false;
    const digest = JSON.stringify(bundle.cells);
    if (
      this.lastCards &&
      this.lastCards.digest === digest &&
      now - this.lastCards.at < CARDS_REFRESH_MS
    )
      return false;
    await this.publish(
      Buffer.from(JSON.stringify({ type: "cards", body: bundle })).toString("base64"),
    );
    this.lastCards = { digest, at: now };
    return true;
  }
  private scheduleCards(): void {
    const run = () =>
      void this.publishCards().catch((error: unknown) =>
        log.debug(`Skill cards not announced: ${String(error)}`),
      );
    const first = setTimeout(run, CARDS_FIRST_MS);
    const every = setInterval(run, CARDS_CHECK_MS);
    first.unref();
    every.unref();
    this.cardTimers = [first, every];
  }
  async stop(): Promise<void> {
    this.unsub?.();
    for (const timer of this.cardTimers) clearTimeout(timer);
    this.cardTimers = [];
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
        await this.publish(
          Buffer.from(JSON.stringify({ type: "withdrawal", body })).toString("base64"),
        );
      },
      evidence: async (body) => {
        if (!this.enabled() || body.scope.kind !== "public")
          throw new Error("Evidence scope mismatch");
        await this.publish(
          Buffer.from(JSON.stringify({ type: "evidence", body })).toString("base64"),
        );
      },
      announce: async (value) => {
        if (!this.enabled() || value.scope.kind !== "public")
          throw new Error("Public publication not enabled");
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > 16384) throw new Error("Announcement too large");
        await this.publish(bytes.toString("base64"));
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
