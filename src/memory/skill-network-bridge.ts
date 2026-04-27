/**
 * SkillNetworkBridge: mediates between the Knowledge Crystal memory system
 * and the P2P network (via OrchestratorBridge).
 *
 * Outbound: dream-generated skill crystals → P2P network
 * Inbound: P2P skill envelopes → Knowledge Crystal in memory
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import type { CuriosityEngine } from "./curiosity-engine.js";
import type { ExplorationTargetType } from "./curiosity-types.js";
import type { HormonalStateManager } from "./hormonal.js";
import type { PublishResult, ImportResult } from "./mem-store.js";
import type { PeerReputationManager } from "./peer-reputation.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import type { SkillVerifier } from "./skill-verifier.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { scanSkillForInjection } from "../security/skill-injection-scanner.js";
import { SkillVersionResolver } from "./skill-version-resolver.js";

const log = createSubsystemLogger("memory/skill-network-bridge");

/** Network-wide census snapshot received over gossipsub. Mirrors the JSON
 * shape published by `BootnodeRegistry::census` on the Rust side, plus a
 * `received_at` timestamp added on receipt. */
export type NetworkCensusSnapshot = {
  enabled: boolean;
  lifetime_unique_peers: number;
  active_last_24h: number;
  active_last_7d: number;
  by_tier: Record<string, number>;
  by_address_type: Record<string, number>;
  generated_at: number;
  received_at?: number;
};

export type OrchestratorBridgeLike = {
  publishSkill(skillMd: string, name: string): Promise<unknown>;
  publishTelemetry?(signalType: string, data: unknown): Promise<unknown>;
  publishQuery?(queryId: string, query: string, domainHint?: string): Promise<unknown>;
};

export type SkillNetworkBridgeConfig = {
  autoPublishOnCrystallize?: boolean;
};

export class SkillNetworkBridge {
  private readonly db: DatabaseSync;
  private orchestratorBridge: OrchestratorBridgeLike | null;
  private readonly config: Required<SkillNetworkBridgeConfig>;
  private peerReputation: PeerReputationManager | null;
  private hormonalManager: HormonalStateManager | null = null;
  private curiosityEngine: CuriosityEngine | null = null;
  private versionResolver: SkillVersionResolver;
  private executionTracker: SkillExecutionTracker | null = null;
  private skillVerifier: SkillVerifier | null = null;
  /** Latest bootnode census snapshot received over gossipsub. Per-source so
   * multiple bootnodes don't overwrite each other; the freshest entry wins
   * when getLatestNetworkCensus() is called. */
  private censusSnapshots: Map<string, NetworkCensusSnapshot> = new Map();

  constructor(
    db: DatabaseSync,
    orchestratorBridge: OrchestratorBridgeLike | null,
    config?: SkillNetworkBridgeConfig,
    peerReputation?: PeerReputationManager | null,
  ) {
    this.db = db;
    this.orchestratorBridge = orchestratorBridge;
    this.config = {
      autoPublishOnCrystallize: config?.autoPublishOnCrystallize ?? true,
    };
    this.peerReputation = peerReputation ?? null;
    this.versionResolver = new SkillVersionResolver(db);
  }

  /**
   * Wire or replace the peer reputation manager.
   */
  /** Plan 8, Phase 3: Wire SkillVerifier for P2P ingest safety gate. */
  setSkillVerifier(verifier: SkillVerifier | null): void {
    this.skillVerifier = verifier;
  }

  setPeerReputation(manager: PeerReputationManager | null): void {
    this.peerReputation = manager;
  }

  /**
   * Record a peer-identified observation against the local reputation table.
   *
   * Drives the lifetime-unique-peer count: every successful libp2p identify
   * upserts a peer_reputation row with first_seen_at/last_seen_at, even when
   * the peer never publishes a skill. `SELECT COUNT(*) FROM peer_reputation`
   * is therefore the authoritative local "peers ever seen" number.
   */
  recordPeerSeen(peerPubkey: string, peerId: string): void {
    if (!this.peerReputation || !peerPubkey) {
      return;
    }
    try {
      this.peerReputation.recordPeerSeen(peerPubkey, peerId);
    } catch (err) {
      log.debug(`recordPeerSeen failed: ${String(err)}`);
    }
  }

  /**
   * Persist a bootnode census snapshot received over gossipsub. Keyed on
   * the publishing peer's libp2p PeerId so distinct bootnodes don't trample
   * each other; the freshest entry wins on read.
   */
  recordCensusSnapshot(sourcePeerId: string, snapshot: NetworkCensusSnapshot): void {
    if (!sourcePeerId) {
      return;
    }
    this.censusSnapshots.set(sourcePeerId, {
      ...snapshot,
      received_at: Date.now(),
    });
    // Cap to a small set so a misbehaving peer can't blow up memory.
    const MAX_SOURCES = 32;
    if (this.censusSnapshots.size > MAX_SOURCES) {
      const oldestKey = [...this.censusSnapshots.entries()].toSorted(
        (a, b) => (a[1].received_at ?? 0) - (b[1].received_at ?? 0),
      )[0]?.[0];
      if (oldestKey) {
        this.censusSnapshots.delete(oldestKey);
      }
    }
  }

  /**
   * Return the freshest network-wide census snapshot we've heard over
   * gossipsub, or null if no bootnode broadcast has arrived yet.
   */
  getLatestNetworkCensus(): {
    source_peer_id: string;
    snapshot: NetworkCensusSnapshot;
  } | null {
    let best: { peer: string; snap: NetworkCensusSnapshot } | null = null;
    for (const [peer, snap] of this.censusSnapshots.entries()) {
      if (!best || (snap.generated_at ?? 0) > (best.snap.generated_at ?? 0)) {
        best = { peer, snap };
      }
    }
    if (!best) {
      return null;
    }
    return { source_peer_id: best.peer, snapshot: best.snap };
  }

  /**
   * Aggregate peer-network metrics for `/skills.network`. Returns null when
   * no reputation manager is wired (e.g. during early startup).
   */
  getNetworkMetrics(): ReturnType<PeerReputationManager["getNetworkMetrics"]> | null {
    if (!this.peerReputation) {
      return null;
    }
    try {
      return this.peerReputation.getNetworkMetrics();
    } catch (err) {
      log.debug(`getNetworkMetrics failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Wire or replace the orchestrator bridge after construction.
   * Useful when the P2P bridge starts after the memory subsystem.
   */
  setOrchestratorBridge(bridge: OrchestratorBridgeLike | null): void {
    this.orchestratorBridge = bridge;
  }

  setHormonalManager(manager: HormonalStateManager | null): void {
    this.hormonalManager = manager;
  }

  setCuriosityEngine(engine: CuriosityEngine | null): void {
    this.curiosityEngine = engine;
  }

  setExecutionTracker(tracker: SkillExecutionTracker | null): void {
    this.executionTracker = tracker;
  }

  /**
   * Outbound: publish a crystal skill to the P2P network.
   */
  async publishCrystalSkill(crystalId: string): Promise<PublishResult | null> {
    if (!this.orchestratorBridge) {
      log.debug("no orchestrator bridge, skipping publish");
      return null;
    }

    // Read crystal from DB
    const row = this.db
      .prepare(`SELECT id, text, path, governance_json FROM chunks WHERE id = ?`)
      .get(crystalId) as
      | {
          id: string;
          text: string;
          path: string;
          governance_json: string | null;
        }
      | undefined;

    if (!row) {
      log.warn(`publishCrystalSkill: crystal ${crystalId} not found`);
      return null;
    }

    // Governance check: only publish shared or public crystals
    let governance: Record<string, unknown> = {};
    try {
      if (row.governance_json) {
        governance = JSON.parse(row.governance_json);
      }
    } catch {}

    const scope = governance.accessScope;
    if (scope !== "shared" && scope !== "public") {
      log.debug(`crystal ${crystalId} is ${String(scope)}, skipping network publish`);
      return null;
    }

    // Check sensitivity - never publish confidential
    if (governance.sensitivity === "confidential") {
      log.debug(`crystal ${crystalId} is confidential, skipping network publish`);
      return null;
    }

    // Check provenance for confidential parents
    if (!this.checkProvenanceSafe(crystalId)) {
      log.debug(`crystal ${crystalId} has confidential ancestors, skipping`);
      return null;
    }

    // Generate SKILL.md from crystal content and base64-encode for the wire protocol
    const skillMd = this.generateSkillMd(row.text, row.path, crystalId);
    const skillMdBase64 = Buffer.from(skillMd, "utf-8").toString("base64");
    const name = this.extractSkillName(row.path, crystalId);

    try {
      const raw = await this.orchestratorBridge.publishSkill(skillMdBase64, name);
      const result = raw as { ok?: boolean; content_hash?: string } | undefined;
      if (result?.ok) {
        const now = Date.now();
        // Update crystal's publish state
        this.db
          .prepare(`UPDATE chunks SET publish_visibility = 'shared', published_at = ? WHERE id = ?`)
          .run(now, crystalId);

        // Audit log
        this.db
          .prepare(
            `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            crystalId,
            "skill_network_published",
            now,
            "skill_network_bridge",
            JSON.stringify({ content_hash: result.content_hash }),
          );

        log.debug("crystal published to network", { crystalId, name });
        return { crystalId, visibility: "shared", publishedAt: now };
      }
    } catch (err) {
      log.warn(`failed to publish crystal ${crystalId}: ${String(err)}`);
    }

    return null;
  }

  /**
   * Inbound: ingest a skill envelope from the P2P network into memory.
   */
  ingestNetworkSkill(envelope: SkillEnvelope): ImportResult {
    if (!envelope.content_hash || !envelope.skill_md) {
      return { ok: false, action: "rejected", reason: "invalid envelope" };
    }

    // Reject skills from banned peers
    if (envelope.author_pubkey && this.peerReputation?.isBanned(envelope.author_pubkey)) {
      return { ok: false, action: "rejected", reason: "peer is banned" };
    }

    // Cortisol gate: during network cortisol spike, halt untrusted ingestion
    if (this.hormonalManager) {
      const modulation = this.hormonalManager.getConsolidationModulation();
      if (modulation.haltUntrustedIngestion) {
        const trustLevel = this.peerReputation?.getTrustLevel(envelope.author_pubkey);
        if (trustLevel !== "trusted" && trustLevel !== "verified") {
          return {
            ok: false,
            action: "rejected",
            reason: "network cortisol spike: untrusted peer halted",
          };
        }
      }
    }

    // Check for duplicate content
    const existing = this.db
      .prepare(`SELECT id FROM chunks WHERE hash = ?`)
      .get(envelope.content_hash) as { id: string } | undefined;

    if (existing) {
      return { ok: false, action: "rejected", reason: "duplicate content", crystalId: existing.id };
    }

    // ── Version conflict resolution ────────────────────────────────────
    // If the envelope carries versioning metadata, run it through the
    // SkillVersionResolver before inserting. This implements local
    // natural-selection: fitter variants win, losers decay via Ebbinghaus.
    if (envelope.stable_skill_id && envelope.skill_version != null) {
      const incomingFitness = {
        executionSuccessRate: null, // new skill, never executed locally
        executionCount: 0,
        peerTrust: this.peerReputation?.getTrustScore(envelope.author_pubkey) ?? 0.5,
        ageMs: 0,
      };

      const resolution = this.versionResolver.resolveConflict(
        {
          stableSkillId: envelope.stable_skill_id,
          version: envelope.skill_version,
          contentHash: envelope.content_hash,
          parentContentHash: envelope.previous_content_hash ?? null,
          authorPubkey: envelope.author_pubkey,
        },
        incomingFitness,
        (crystalId, authorPubkey) => {
          const metrics = this.executionTracker?.getSkillMetrics(crystalId);
          return {
            executionSuccessRate:
              metrics && metrics.totalExecutions > 0 ? metrics.successRate : null,
            executionCount: metrics?.totalExecutions ?? 0,
            peerTrust: this.peerReputation?.getTrustScore(authorPubkey) ?? 0.5,
            ageMs: Date.now() - (metrics?.lastExecutedAt ?? Date.now()),
          };
        },
      );

      if (resolution.action === "keep_existing") {
        log.debug("version conflict resolved: keeping existing", {
          skill: envelope.stable_skill_id,
          version: envelope.skill_version,
          reason: resolution.reason,
        });
        return {
          ok: false,
          action: "rejected",
          reason: `version conflict: ${resolution.reason}`,
          crystalId: resolution.winner.crystalId,
        };
      }

      // For "accept_new", we continue to the INSERT below.
      // For "keep_both", we also continue — both variants coexist.
      log.debug("version conflict resolved", {
        action: resolution.action,
        skill: envelope.stable_skill_id,
        version: envelope.skill_version,
        reason: resolution.reason,
      });
    }

    // Decode content
    let content: string;
    try {
      content = Buffer.from(envelope.skill_md, "base64").toString("utf-8");
    } catch {
      return { ok: false, action: "rejected", reason: "invalid content encoding" };
    }

    // PLAN-13 Phase A.5: prompt-injection scan on the bridge ingestion path.
    // The filesystem ingest in src/agents/skills/ingest.ts already runs this,
    // but crystals reach memory via this parallel route too. Same threat,
    // same defense: a critical hit rejects the skill outright (the bridge
    // has no quarantine concept; rejection is the analog) and feeds a
    // negative reputation signal scaled by severity.
    const scan = scanSkillForInjection(content);
    if (scan.severity !== "ok") {
      log.warn("P2P skill flagged by injection scanner", {
        author: envelope.author_peer_id,
        severity: scan.severity,
        flags: scan.flags,
      });
      this.peerReputation?.recordInjectionFlag?.(envelope.author_pubkey, scan.severity);
      if (scan.severity === "critical") {
        return {
          ok: false,
          action: "rejected",
          reason: `injection scan critical: ${scan.flags.join(", ")}`,
        };
      }
    }

    // Plan 8, Phase 3: Safety gate — verify inbound skill content
    if (this.skillVerifier) {
      const verification = this.skillVerifier.verify(content, null);
      if (!verification.passed) {
        log.warn("P2P skill rejected by verifier", {
          author: envelope.author_peer_id,
          reason: verification.overallReason,
          checks: verification.checks
            .filter((c: { passed: boolean; name: string }) => !c.passed)
            .map((c: { name: string }) => c.name),
        });
        // Record negative trust signal
        if (this.peerReputation) {
          this.peerReputation.recordTrustEdge("local", envelope.author_pubkey, 0.2);
        }
        return { ok: false, action: "rejected", reason: verification.overallReason };
      }
    }

    // Check management verification
    let isVerified = false;
    let verifiedBy: string | null = null;
    if (envelope.management_signature && envelope.management_pubkey) {
      if (this.peerReputation?.isManagementNode(envelope.management_pubkey)) {
        isVerified = this.verifyManagementSignature(envelope);
        if (isVerified) {
          verifiedBy = envelope.management_pubkey;
        }
      }
    }

    // Store as crystal with peer provenance
    const id = crypto.randomUUID();
    const now = Date.now();
    const governance = JSON.stringify({
      accessScope: "shared",
      lifespanPolicy: "permanent",
      priority: 0.5,
      sensitivity: "normal",
      provenanceChain: [],
      peerOrigin: envelope.author_pubkey,
    });

    const provenanceDag = JSON.stringify([
      {
        crystalId: id,
        operation: "imported",
        actor: `peer:${envelope.author_pubkey}`,
        timestamp: now,
        parentIds: [],
        metadata: {
          peerPeerId: envelope.author_peer_id,
          contentHash: envelope.content_hash,
        },
      },
    ]);

    try {
      // Compute lineage hash for versioned skills
      const lineageHash = envelope.stable_skill_id
        ? SkillVersionResolver.lineageHash(
            envelope.stable_skill_id,
            envelope.previous_content_hash ?? null,
            envelope.author_pubkey,
          )
        : null;

      this.db
        .prepare(
          `INSERT INTO chunks (
            id, path, source, start_line, end_line, text, hash,
            importance_score, model, embedding, updated_at,
            lifecycle_state, lifecycle, semantic_type, governance_json,
            created_at, provenance_dag, is_verified, verified_by,
            lineage_hash, peer_origin
          ) VALUES (
            ?, ?, 'skills', 0, 0, ?, ?,
            0.5, 'peer', '[]', ?,
            'active', 'generated', 'skill', ?,
            ?, ?, ?, ?,
            ?, ?
          )`,
        )
        .run(
          id,
          `peer/${envelope.name}`,
          content,
          envelope.content_hash,
          now,
          governance,
          now,
          provenanceDag,
          isVerified ? 1 : 0,
          verifiedBy,
          lineageHash,
          envelope.author_pubkey,
        );

      // Plan 8, Phase 1: Store peer wallet address for revenue sharing
      if ((envelope as Record<string, unknown>).author_wallet_address && this.peerReputation) {
        this.peerReputation.updateWalletAddress(
          envelope.author_pubkey,
          (envelope as Record<string, unknown>).author_wallet_address as string,
        );
      }

      log.debug("network skill ingested as crystal", {
        id,
        peer: envelope.author_peer_id,
        name: envelope.name,
      });

      return { ok: true, action: "accepted", crystalId: id };
    } catch (err) {
      log.warn(`ingest failed: ${String(err)}`);
      return { ok: false, action: "rejected", reason: String(err) };
    }
  }

  /**
   * Hook called when SkillRefiner crystallizes a mutation.
   * Triggers network publish if configured. Also checks bounty matches.
   */
  onSkillCrystallized(crystalId: string): void {
    // Check bounty match
    if (this.curiosityEngine && this.hormonalManager) {
      const row = this.db.prepare(`SELECT text FROM chunks WHERE id = ?`).get(crystalId) as
        | { text: string }
        | undefined;
      if (row?.text) {
        const match = this.curiosityEngine.checkBountyMatch(crystalId, row.text);
        if (match) {
          // Massive dopamine boost: stimulate "achievement" scaled by reward_multiplier
          const stimCount = Math.min(5, Math.ceil(match.rewardMultiplier));
          for (let i = 0; i < stimCount; i++) {
            this.hormonalManager.stimulate("achievement");
          }
          // Record bounty match on the crystal
          this.db
            .prepare(
              `UPDATE chunks SET bounty_match_id = ?, bounty_priority_boost = ? WHERE id = ?`,
            )
            .run(match.bountyId, match.rewardMultiplier, crystalId);

          // Plan 8, Phase 4: Bounty USDC payout — quality gate + claim publishing
          if (match.rewardUsdc > 0 && this.orchestratorBridge) {
            const meetsQuality = this.checkBountyClaimQuality(crystalId, row.text);
            if (meetsQuality) {
              this.orchestratorBridge
                .publishTelemetry?.("bounty_claim", {
                  bountyId: match.bountyId,
                  skillCrystalId: crystalId,
                  claimerWalletAddress: this.getLocalWalletAddress(),
                  contentHash: crypto.createHash("sha256").update(row.text).digest("hex"),
                  rewardUsdc: match.rewardUsdc,
                })
                .catch((err) => {
                  log.warn(`bounty claim publish failed: ${String(err)}`);
                });
              log.info("bounty claim published", {
                bountyId: match.bountyId,
                crystalId,
                rewardUsdc: match.rewardUsdc,
              });
            } else {
              log.debug("bounty match found but quality gate not met", {
                bountyId: match.bountyId,
                crystalId,
              });
            }
          }
        }
      }
    }

    // Always attempt publish (priority upload for bounty matches)
    if (this.config.autoPublishOnCrystallize) {
      this.publishCrystalSkill(crystalId).catch((err) => {
        log.warn(`onSkillCrystallized publish failed: ${String(err)}`);
      });
    }
  }

  /**
   * Plan 8, Phase 4: Quality gate for bounty claims.
   * Reuses SkillCrystallizer's thresholds: SkillVerifier passes + 3 executions + >70% success.
   */
  private checkBountyClaimQuality(crystalId: string, text: string): boolean {
    // 1. SkillVerifier must pass
    if (this.skillVerifier) {
      const result = this.skillVerifier.verify(text, null);
      if (!result.passed) {
        return false;
      }
    }

    // 2. Execution metrics: 3+ runs, >70% success
    if (this.executionTracker) {
      const metrics = this.executionTracker.getSkillMetrics(crystalId);
      if (metrics.totalExecutions < 3) {
        return false;
      }
      if (metrics.successRate < 0.7) {
        return false;
      }
    }

    return true;
  }

  /** Resolve this node's wallet address for bounty claim payouts. */
  private getLocalWalletAddress(): string | null {
    try {
      // Read from config or wallet service cache
      const row = this.db
        .prepare(`SELECT wallet_address FROM peer_reputation WHERE peer_pubkey = 'local'`)
        .get() as { wallet_address: string | null } | undefined;
      return row?.wallet_address ?? null;
    } catch {
      return null;
    }
  }

  handleWeatherEvent(event: {
    global_cortisol_spike: number;
    duration_ms: number;
    reason: string;
  }): void {
    this.hormonalManager?.applyNetworkCortisolSpike(
      event.global_cortisol_spike,
      event.duration_ms,
      event.reason,
    );
  }

  handleBountyEvent(bounty: {
    bounty_id: string;
    target_type: string;
    description: string;
    priority: number;
    reward_multiplier: number;
    region_hint?: string;
    expires_at: number;
    reward_usdc?: number;
    poster_peer_id?: string;
    poster_wallet_address?: string;
  }): void {
    if (!this.curiosityEngine) {
      return;
    }
    const validTypes = ["knowledge_gap", "contradiction", "stale_region", "frontier"];
    const targetType = (
      validTypes.includes(bounty.target_type) ? bounty.target_type : "knowledge_gap"
    ) as ExplorationTargetType;
    this.curiosityEngine.ingestBounty({
      bountyId: bounty.bounty_id,
      targetType,
      description: bounty.description,
      priority: bounty.priority,
      rewardMultiplier: bounty.reward_multiplier,
      regionHint: bounty.region_hint,
      expiresAt: bounty.expires_at,
      // Plan 8, Phase 4: USDC reward info for economic bounty payouts
      rewardUsdc: bounty.reward_usdc,
      posterPeerId: bounty.poster_peer_id,
      posterWalletAddress: bounty.poster_wallet_address,
    });
  }

  /**
   * Handle an incoming telemetry event from the P2P network.
   * Routes to the appropriate subsystem based on signal_type.
   */
  handleTelemetryEvent(event: {
    signal_type: string;
    data: unknown;
    author_peer_id: string;
  }): void {
    if (event.signal_type === "novelty") {
      const data = event.data as
        | { region?: string; surprise_score?: number; domain_hint?: string }
        | undefined;
      if (data?.region && typeof data.surprise_score === "number" && this.curiosityEngine) {
        this.curiosityEngine.handleNoveltySignal({
          region: data.region,
          surprise_score: data.surprise_score,
          domain_hint: data.domain_hint,
        });
      }
    }
    // Other signal types (e.g., "experience") can be routed here in the future
  }

  /**
   * Emit a novelty signal to the network after a high-surprise assessment.
   * Called from the indexing pipeline after assessChunk returns above threshold.
   */
  async emitNoveltySignal(assessment: {
    regionId: string | null;
    compositeReward: number;
    noveltyScore: number;
  }): Promise<void> {
    if (!this.orchestratorBridge?.publishTelemetry) {
      return;
    }
    if (!this.curiosityEngine) {
      return;
    }

    // Look up region label
    let regionLabel = "unknown";
    if (assessment.regionId) {
      const row = this.db
        .prepare(`SELECT label FROM curiosity_regions WHERE id = ?`)
        .get(assessment.regionId) as { label: string } | undefined;
      if (row) {
        regionLabel = row.label;
      }
    }

    try {
      await this.orchestratorBridge.publishTelemetry("novelty", {
        region: regionLabel,
        surprise_score: assessment.compositeReward,
        domain_hint: regionLabel,
      });
      log.debug(
        `novelty signal emitted: region=${regionLabel} score=${assessment.compositeReward.toFixed(3)}`,
      );
    } catch (err) {
      log.debug(`failed to emit novelty signal: ${String(err)}`);
    }
  }

  /**
   * Handle an incoming query from a peer. Match against local crystals and
   * respond by publishing matching skills back to the network.
   */
  async handleQueryEvent(event: {
    query_id: string;
    query: string;
    domain_hint?: string;
    author_peer_id: string;
  }): Promise<void> {
    if (!this.curiosityEngine || !this.orchestratorBridge) {
      return;
    }

    // Use CuriosityEngine to match query against local knowledge regions
    const matches = this.curiosityEngine.matchQuery(event.query);
    if (matches.length === 0) {
      log.debug(`query '${event.query}' from ${event.author_peer_id}: no matches`);
      return;
    }

    // Find best-matching crystals with high importance
    const crystals = this.db
      .prepare(
        `SELECT id, text, path, importance_score, governance_json
       FROM chunks
       WHERE lifecycle_state = 'active' AND semantic_type = 'skill'
       ORDER BY importance_score DESC LIMIT 3`,
      )
      .all() as Array<{
      id: string;
      text: string;
      path: string;
      importance_score: number;
      governance_json: string | null;
    }>;

    // Publish matching crystals as skill responses
    for (const crystal of crystals) {
      // Governance check
      let gov: Record<string, unknown> = {};
      try {
        if (crystal.governance_json) {
          gov = JSON.parse(crystal.governance_json);
        }
      } catch {}
      if (gov.accessScope !== "shared" && gov.accessScope !== "public") {
        continue;
      }
      if (gov.sensitivity === "confidential") {
        continue;
      }

      const skillMd = this.generateSkillMd(crystal.text, crystal.path, crystal.id);
      const skillMdBase64 = Buffer.from(skillMd, "utf-8").toString("base64");
      const name = `response-${event.query_id.slice(0, 8)}-${this.extractSkillName(crystal.path, crystal.id)}`;

      try {
        await this.orchestratorBridge.publishSkill(skillMdBase64, name);
        log.debug(`query response sent: crystal=${crystal.id} for query '${event.query}'`);
      } catch (err) {
        log.debug(`failed to respond to query: ${String(err)}`);
      }
    }
  }

  /**
   * Emit a P2P query from a CuriosityEngine exploration target.
   * Called during the curiosity cycle when high-priority targets have no local resolution.
   */
  async emitNetworkQuery(description: string, domainHint?: string): Promise<void> {
    if (!this.orchestratorBridge?.publishQuery) {
      return;
    }

    const queryId = crypto.randomUUID();
    try {
      await this.orchestratorBridge.publishQuery(queryId, description, domainHint);
      log.debug(`network query emitted: id=${queryId} '${description}'`);
    } catch (err) {
      log.debug(`failed to emit network query: ${String(err)}`);
    }
  }

  private verifyManagementSignature(envelope: SkillEnvelope): boolean {
    try {
      const pubkeyBytes = Buffer.from(envelope.management_pubkey!, "base64");
      const sigBytes = Buffer.from(envelope.management_signature!, "base64");
      const skillBytes = Buffer.from(envelope.skill_md, "base64");
      // Wrap raw Ed25519 pubkey in SPKI DER for Node.js crypto
      const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
      const spkiDer = Buffer.concat([spkiPrefix, pubkeyBytes]);
      const publicKey = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
      return crypto.verify(null, skillBytes, publicKey, sigBytes);
    } catch {
      return false;
    }
  }

  private generateSkillMd(text: string, path: string, crystalId: string): string {
    const name = this.extractSkillName(path, crystalId);
    return (
      `---\nname: ${name}\ndescription: Dream-generated skill crystal\n` +
      `crystal_id: ${crystalId}\n---\n\n${text}`
    );
  }

  private extractSkillName(path: string, crystalId: string): string {
    const parts = path.split("/");
    const last = parts[parts.length - 1] ?? crystalId;
    return last.replace(/[^a-z0-9-]/gi, "-").slice(0, 64) || crystalId.slice(0, 8);
  }

  /**
   * Check that the crystal's provenance doesn't include confidential ancestors.
   * Checks both legacy provenance_chain column and the newer provenance_dag column.
   */
  private checkProvenanceSafe(crystalId: string): boolean {
    const row = this.db
      .prepare(`SELECT provenance_chain, provenance_dag FROM chunks WHERE id = ?`)
      .get(crystalId) as
      | {
          provenance_chain: string | null;
          provenance_dag: string | null;
        }
      | undefined;

    if (!row) {
      return true;
    }

    // Collect all ancestor IDs from both provenance sources
    const ancestorIds = new Set<string>();

    // Legacy flat chain (string[])
    if (row.provenance_chain) {
      try {
        const chain: string[] = JSON.parse(row.provenance_chain);
        for (const id of chain) {
          ancestorIds.add(id);
        }
      } catch {
        log.debug(`invalid provenance_chain JSON for crystal ${crystalId}`);
      }
    }

    // Structured provenance DAG (ProvenanceNode[])
    if (row.provenance_dag) {
      try {
        const dag = JSON.parse(row.provenance_dag) as Array<{
          parentIds?: string[];
          crystalId?: string;
        }>;
        for (const node of dag) {
          if (node.parentIds) {
            for (const id of node.parentIds) {
              ancestorIds.add(id);
            }
          }
        }
      } catch {
        log.debug(`invalid provenance_dag JSON for crystal ${crystalId}`);
      }
    }

    if (ancestorIds.size === 0) {
      return true;
    }

    // Check each ancestor for confidential sensitivity
    for (const ancestorId of ancestorIds) {
      const ancestor = this.db
        .prepare(`SELECT governance_json FROM chunks WHERE id = ?`)
        .get(ancestorId) as { governance_json: string | null } | undefined;

      if (ancestor?.governance_json) {
        try {
          const gov = JSON.parse(ancestor.governance_json);
          if (gov.sensitivity === "confidential") {
            return false;
          }
        } catch {
          log.debug(`invalid governance_json for ancestor ${ancestorId}`);
        }
      }
    }

    return true;
  }
}
