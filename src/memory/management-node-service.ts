/**
 * ManagementNodeService: network oversight for management-tier nodes.
 *
 * Aggregates telemetry, computes network-wide analytics, detects anomalies,
 * and provides economic oversight. Only active on management nodes.
 */
import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { OrchestratorBridge } from "../infra/orchestrator-bridge.js";
import type { PeerReputationManager } from "./peer-reputation.js";
import type { MarketplaceEconomics } from "./marketplace-economics.js";
import type { ManagementKeyAuth } from "./management-key-auth.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/management-node");

export interface NetworkCensus {
  totalPeersSeen: number;
  peersByTier: Record<string, number>;
  skillsPublishedNetworkWide: number;
  telemetryCountsByType: Record<string, number>;
  networkHealthScore: number;
  lastCensusAt: number;
  connectedPeers: number;
  peerCountHistory: Array<[number, number]>;
}

export interface AnomalyAlert {
  alertType: string;
  severity: "low" | "medium" | "high" | "critical";
  peerIds: string[];
  description: string;
  detectedAt: number;
  autoAction?: string;
}

export interface NetworkEconomicOverview {
  totalSkillsListed: number;
  averagePrice: number;
  transactionVolume: number;
  topSellers: Array<{ peerId: string; revenue: number }>;
  snapshotCount: number;
}

export class ManagementNodeService {
  private readonly db: DatabaseSync;
  private readonly bridge: OrchestratorBridge;
  private readonly peerReputation: PeerReputationManager | null;
  private readonly economics: MarketplaceEconomics | null;
  private readonly auth: ManagementKeyAuth | null;
  private censusInterval: ReturnType<typeof setInterval> | null = null;
  private anomalyInterval: ReturnType<typeof setInterval> | null = null;
  private economicInterval: ReturnType<typeof setInterval> | null = null;
  private latestCensus: NetworkCensus | null = null;
  private anomalyHistory: AnomalyAlert[] = [];

  constructor(
    db: DatabaseSync,
    bridge: OrchestratorBridge,
    peerReputation?: PeerReputationManager | null,
    economics?: MarketplaceEconomics | null,
    auth?: ManagementKeyAuth | null,
  ) {
    this.db = db;
    this.bridge = bridge;
    this.peerReputation = peerReputation ?? null;
    this.economics = economics ?? null;
    this.auth = auth ?? null;
    this.ensureSchema();
  }

  /** Whether this service has cryptographic management key authorization. */
  get isAuthorized(): boolean {
    return this.auth !== null;
  }

  /** The base64 public key of this management node, or null if unauthorized. */
  get publicKey(): string | null {
    return this.auth?.publicKeyBase64 ?? null;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS management_census_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        connected_peers INTEGER,
        peers_by_tier TEXT,
        skills_network_wide INTEGER,
        health_score REAL,
        anomaly_count INTEGER
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS management_anomaly_log (
        id TEXT PRIMARY KEY,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        peer_ids TEXT,
        description TEXT,
        detected_at INTEGER NOT NULL,
        auto_action TEXT,
        resolved_at INTEGER
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS management_economic_snapshots (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        total_listings INTEGER,
        avg_price REAL,
        transaction_volume REAL,
        unique_sellers INTEGER,
        unique_buyers INTEGER
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mgmt_census_ts ON management_census_log(timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mgmt_anomaly_ts ON management_anomaly_log(detected_at)`);
  }

  /**
   * Start periodic management operations.
   * Requires cryptographic authorization — throws if auth is not set.
   */
  start(): void {
    if (!this.auth) {
      throw new Error(
        "ManagementNodeService cannot start without cryptographic authorization. " +
          "Set BITTERBOT_MANAGEMENT_KEY env var with a base64 Ed25519 private key " +
          "whose public key is in the genesis trust list.",
      );
    }

    // Census every 60 seconds
    this.censusInterval = setInterval(() => {
      this.runCensus().catch((err) => log.warn(`Census failed: ${String(err)}`));
    }, 60_000);

    // Economic snapshot every 5 minutes
    this.economicInterval = setInterval(() => {
      this.captureEconomicSnapshot();
    }, 300_000);

    // Listen for anomaly and bounty claim events from Rust orchestrator
    this.bridge.onTelemetryReceived?.((event: {
      signal_type: string;
      data: unknown;
      author_peer_id: string;
      timestamp: number;
    }) => {
      if (event.signal_type === "management_ban") {
        this.handleBanReceived(event);
      } else if (event.signal_type === "bounty_claim") {
        this.handleBountyClaim(event.data as {
          bountyId: string; skillCrystalId: string;
          claimerWalletAddress: string | null; contentHash: string; rewardUsdc: number;
        }, event.author_peer_id).catch((err) => {
          log.warn(`bounty claim processing failed: ${String(err)}`);
        });
      }
    });

    log.info(`ManagementNodeService started (pubkey: ${this.auth.publicKeyBase64.substring(0, 8)}...)`);
  }

  stop(): void {
    if (this.censusInterval) clearInterval(this.censusInterval);
    if (this.anomalyInterval) clearInterval(this.anomalyInterval);
    if (this.economicInterval) clearInterval(this.economicInterval);
    this.censusInterval = null;
    this.anomalyInterval = null;
    this.economicInterval = null;
    log.info("ManagementNodeService stopped");
  }

  /** Pull network census from Rust orchestrator via IPC. */
  async runCensus(): Promise<NetworkCensus | null> {
    try {
      const result = await (this.bridge as any).sendCommand("get_network_census", {});
      if (!result?.ok) return null;

      const census: NetworkCensus = {
        totalPeersSeen: result.total_peers_seen ?? 0,
        peersByTier: result.peers_by_tier ?? {},
        skillsPublishedNetworkWide: result.skills_published_network_wide ?? 0,
        telemetryCountsByType: result.telemetry_counts_by_type ?? {},
        networkHealthScore: result.network_health_score ?? 1.0,
        lastCensusAt: result.last_census_at ?? 0,
        connectedPeers: result.connected_peers ?? 0,
        peerCountHistory: result.peer_count_history ?? [],
      };

      this.latestCensus = census;

      // Persist to DB
      this.db.prepare(
        `INSERT OR REPLACE INTO management_census_log
         (id, timestamp, connected_peers, peers_by_tier, skills_network_wide, health_score, anomaly_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        Date.now(),
        census.connectedPeers,
        JSON.stringify(census.peersByTier),
        census.skillsPublishedNetworkWide,
        census.networkHealthScore,
        this.anomalyHistory.length,
      );

      return census;
    } catch (err) {
      log.debug(`Census IPC failed: ${String(err)}`);
      return null;
    }
  }

  /** Get anomaly alerts from Rust orchestrator. */
  async getAnomalyAlerts(): Promise<AnomalyAlert[]> {
    try {
      const result = await (this.bridge as any).sendCommand("get_anomaly_alerts", {});
      if (!result?.ok) return this.anomalyHistory;

      const alerts = (result.alerts ?? []).map((a: any) => ({
        alertType: a.alert_type,
        severity: a.severity,
        peerIds: a.peer_ids ?? [],
        description: a.description ?? "",
        detectedAt: a.detected_at ?? Date.now(),
        autoAction: a.auto_action,
      }));

      // Persist new alerts
      for (const alert of alerts) {
        if (!this.anomalyHistory.some((h) => h.detectedAt === alert.detectedAt && h.alertType === alert.alertType)) {
          this.anomalyHistory.push(alert);
          this.db.prepare(
            `INSERT OR IGNORE INTO management_anomaly_log
             (id, alert_type, severity, peer_ids, description, detected_at, auto_action)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            crypto.randomUUID(),
            alert.alertType,
            alert.severity,
            JSON.stringify(alert.peerIds),
            alert.description,
            alert.detectedAt,
            alert.autoAction ?? null,
          );
        }
      }

      // Cap history
      if (this.anomalyHistory.length > 200) {
        this.anomalyHistory = this.anomalyHistory.slice(-200);
      }

      return alerts;
    } catch (err) {
      log.debug(`Anomaly alerts IPC failed: ${String(err)}`);
      return this.anomalyHistory;
    }
  }

  /** Propagate a ban decision to the network. Requires auth to sign the command. */
  async propagateBan(peerPubkey: string, reason: string): Promise<boolean> {
    if (!this.auth) {
      log.warn("Cannot propagate ban without management key authorization");
      return false;
    }

    try {
      const signedEnvelope = this.auth.signCommand("propagate_ban", {
        peer_pubkey: peerPubkey,
        reason,
      });

      const result = await (this.bridge as any).sendCommand("propagate_ban", {
        peer_pubkey: peerPubkey,
        reason,
        management_pubkey: signedEnvelope.pubkey,
        management_signature: signedEnvelope.signature,
        timestamp: signedEnvelope.timestamp,
      });
      if (result?.ok) {
        this.peerReputation?.banPeer(peerPubkey);
        log.info(`Signed ban propagated for ${peerPubkey}: ${reason}`);
        return true;
      }
      return false;
    } catch (err) {
      log.warn(`Ban propagation failed: ${String(err)}`);
      return false;
    }
  }

  /** Handle economic telemetry from the network — aggregate cross-node transaction data. */
  handleEconomicTelemetry(event: { signal_type: string; data: unknown; author_peer_id: string; timestamp: number }): void {
    try {
      const data = event.data as Record<string, unknown> | undefined;
      if (!data) return;

      // Track marketplace events from peer telemetry
      if (event.signal_type === "marketplace_sale" || event.signal_type === "marketplace_purchase") {
        this.db.prepare(
          `INSERT OR IGNORE INTO management_economic_snapshots
           (id, timestamp, total_listings, avg_price, transaction_volume, unique_sellers, unique_buyers)
           VALUES (?, ?, 0, ?, ?, 1, 1)`,
        ).run(
          crypto.randomUUID(),
          event.timestamp * 1000,
          (data.amount_usdc as number) ?? 0,
          (data.amount_usdc as number) ?? 0,
        );
      }
    } catch (err) {
      log.debug(`Economic telemetry handling failed: ${String(err)}`);
    }
  }

  /** Get network-wide economic aggregation. */
  getNetworkEconomicSummary(): {
    totalTransactions: number;
    totalVolumeUsdc: number;
    last24hVolumeUsdc: number;
    uniquePeersTrading: number;
  } {
    try {
      const total = this.db.prepare(
        `SELECT COUNT(*) as c, COALESCE(SUM(transaction_volume), 0) as v FROM management_economic_snapshots`,
      ).get() as { c: number; v: number };

      const last24h = this.db.prepare(
        `SELECT COALESCE(SUM(transaction_volume), 0) as v FROM management_economic_snapshots WHERE timestamp > ?`,
      ).get(Date.now() - 86400000) as { v: number };

      return {
        totalTransactions: total.c,
        totalVolumeUsdc: total.v,
        last24hVolumeUsdc: last24h.v,
        uniquePeersTrading: (() => { try { return (this.db.prepare(`SELECT COUNT(DISTINCT buyer_peer_id) as c FROM marketplace_purchases WHERE purchased_at > ?`).get(Date.now() - 7 * 24 * 60 * 60 * 1000) as { c: number })?.c ?? 0; } catch { return 0; } })(),
      };
    } catch {
      return { totalTransactions: 0, totalVolumeUsdc: 0, last24hVolumeUsdc: 0, uniquePeersTrading: 0 };
    }
  }

  /** Handle incoming ban from another management node. */
  private handleBanReceived(event: { data: unknown; author_peer_id: string; author_pubkey?: string }): void {
    const data = event.data as { peer_pubkey?: string; reason?: string } | undefined;
    if (!data?.peer_pubkey) return;

    // Verify the ban came from a management node (genesis trust list check)
    const authorPubkey = (event as any).author_pubkey;
    if (!authorPubkey || !this.peerReputation?.isManagementNode(authorPubkey)) {
      log.warn(`Rejected management ban from non-management peer ${event.author_peer_id} (pubkey: ${authorPubkey ?? "missing"})`);
      return;
    }

    this.peerReputation.banPeer(data.peer_pubkey);
    log.info(`Received verified management ban for ${data.peer_pubkey} from ${event.author_peer_id}: ${data.reason ?? "no reason"}`);

    this.anomalyHistory.push({
      alertType: "management_ban_received",
      severity: "high",
      peerIds: [data.peer_pubkey],
      description: `Ban from management node ${event.author_peer_id}: ${data.reason ?? ""}`,
      detectedAt: Date.now(),
      autoAction: "ban_applied",
    });
  }

  /**
   * Plan 8, Phase 4: Handle bounty claim from a peer.
   * Validates the claim and queues USDC payout if legitimate.
   */
  private async handleBountyClaim(
    claim: { bountyId: string; skillCrystalId: string; claimerWalletAddress: string | null; contentHash: string; rewardUsdc: number },
    claimerPeerId: string,
  ): Promise<void> {
    if (!claim.bountyId || !claim.rewardUsdc || claim.rewardUsdc <= 0) return;

    // 1. Check that this bounty exists and hasn't been fulfilled yet
    try {
      const bountyTarget = this.db.prepare(
        `SELECT id, metadata FROM curiosity_targets
         WHERE metadata LIKE ? AND resolved_at IS NOT NULL`,
      ).get(`%"bountyId":"${claim.bountyId}"%`) as { id: string; metadata: string } | undefined;

      // Bounty must have been resolved (matched) — if it's still unresolved, ignore
      if (!bountyTarget) {
        log.debug("bounty claim for unknown/unresolved bounty", { bountyId: claim.bountyId });
        return;
      }

      // 2. Check for duplicate claims (already paid)
      const alreadyPaid = this.db.prepare(
        `SELECT id FROM revenue_payment_queue WHERE skill_crystal_id = ? AND role = 'bounty_reward' AND status IN ('held', 'released', 'paid')`,
      ).get(claim.skillCrystalId) as { id: string } | undefined;
      if (alreadyPaid) {
        log.debug("duplicate bounty claim — already queued/paid", { bountyId: claim.bountyId });
        return;
      }

      // 3. Check claimer reputation (don't pay banned or very low trust peers)
      if (this.peerReputation) {
        if (this.peerReputation.isBanned(claimerPeerId)) {
          log.warn("bounty claim from banned peer", { claimerPeerId });
          return;
        }
        const trust = this.peerReputation.getTrustScore(claimerPeerId);
        if (trust < 0.2) {
          log.warn("bounty claim from very low trust peer", { claimerPeerId, trust });
          return;
        }
      }

      // 4. Queue USDC payout via revenue payment queue (with 48h hold)
      if (!claim.claimerWalletAddress) {
        log.debug("bounty claim has no wallet address — cannot pay", { claimerPeerId });
        return;
      }

      if (this.economics) {
        this.economics.queueRevenuePayment({
          skillCrystalId: claim.skillCrystalId,
          purchaseId: `bounty_${claim.bountyId}`,
          recipientPeerId: claimerPeerId,
          amountUsdc: claim.rewardUsdc,
          role: "bounty_reward",
        });

        log.info("bounty claim accepted — USDC payment queued", {
          bountyId: claim.bountyId,
          claimerPeerId,
          rewardUsdc: claim.rewardUsdc,
        });

        // 5. Broadcast bounty_fulfilled to network
        this.bridge.publishTelemetry?.("bounty_fulfilled", {
          bountyId: claim.bountyId,
          fulfillerPeerId: claimerPeerId,
          rewardUsdc: claim.rewardUsdc,
        }).catch(() => { /* non-critical */ });
      }
    } catch (err) {
      log.warn(`bounty claim processing error: ${String(err)}`);
    }
  }

  /** Capture economic snapshot from local MarketplaceEconomics. */
  private captureEconomicSnapshot(): void {
    if (!this.economics) return;
    try {
      const summary = this.economics.getEconomicSummary();
      this.db.prepare(
        `INSERT INTO management_economic_snapshots
         (id, timestamp, total_listings, avg_price, transaction_volume, unique_sellers, unique_buyers)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        Date.now(),
        summary.listedSkillCount ?? 0,
        summary.listedSkillCount > 0 ? (summary.totalEarningsUsdc / Math.max(1, summary.listedSkillCount)) : 0,
        summary.totalEarningsUsdc ?? 0,
        summary.topEarners?.length ?? 0,
        summary.uniqueBuyers ?? 0,
      );
    } catch (err) {
      log.debug(`Economic snapshot failed: ${String(err)}`);
    }
  }

  /** Get the latest census. */
  getLatestCensus(): NetworkCensus | null {
    return this.latestCensus;
  }

  /** Get census history for dashboard trending. */
  getCensusHistory(limit = 100): Array<Record<string, unknown>> {
    try {
      return this.db.prepare(
        `SELECT * FROM management_census_log ORDER BY timestamp DESC LIMIT ?`,
      ).all(limit) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  /** Get economic overview with historical trend. */
  getEconomicOverview(): NetworkEconomicOverview {
    try {
      const latest = this.db.prepare(
        `SELECT * FROM management_economic_snapshots ORDER BY timestamp DESC LIMIT 1`,
      ).get() as Record<string, unknown> | undefined;

      const count = (this.db.prepare(
        `SELECT COUNT(*) as c FROM management_economic_snapshots`,
      ).get() as { c: number })?.c ?? 0;

      return {
        totalSkillsListed: (latest?.total_listings as number) ?? 0,
        averagePrice: (latest?.avg_price as number) ?? 0,
        transactionVolume: (latest?.transaction_volume as number) ?? 0,
        topSellers: [],
        snapshotCount: count,
      };
    } catch {
      return {
        totalSkillsListed: 0,
        averagePrice: 0,
        transactionVolume: 0,
        topSellers: [],
        snapshotCount: 0,
      };
    }
  }
}
