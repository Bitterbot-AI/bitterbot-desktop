/**
 * PeerReputationManager: graduated trust system for P2P skill exchange.
 *
 * Tracks peer contributions, computes reputation scores, and provides
 * trust levels for access control decisions in the ingestion pipeline.
 *
 * Includes:
 * - Ban/blocklist (Task 5)
 * - EigenTrust web-of-trust scoring (Task 6)
 * - Anomaly detection for publication rate spikes
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { PeerReputation, TrustLevel } from "./crystal-types.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import type { OrchestratorBridgeLike } from "./skill-network-bridge.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/peer-reputation");

export class PeerReputationManager {
  private readonly db: DatabaseSync;
  private readonly executionTracker: SkillExecutionTracker;
  private readonly trustList: string[];

  constructor(db: DatabaseSync, executionTracker: SkillExecutionTracker, trustList: string[] = []) {
    this.db = db;
    this.executionTracker = executionTracker;
    this.trustList = trustList;
  }

  /**
   * Check whether a pubkey belongs to a management node (Genesis Trust List).
   */
  isManagementNode(pubkey: string): boolean {
    return this.trustList.includes(pubkey);
  }

  // ── Ban/Blocklist (Task 5) ──

  /**
   * Ban a peer by pubkey. Banned peers are rejected at ingestion time.
   */
  banPeer(pubkey: string): void {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT peer_pubkey FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(pubkey) as { peer_pubkey: string } | undefined;

    if (existing) {
      this.db.prepare(`UPDATE peer_reputation SET is_banned = 1 WHERE peer_pubkey = ?`).run(pubkey);
    } else {
      this.db
        .prepare(
          `INSERT INTO peer_reputation
           (peer_pubkey, is_banned, skills_received, first_seen_at, last_seen_at)
           VALUES (?, 1, 0, ?, ?)`,
        )
        .run(pubkey, now, now);
    }
    log.debug(`peer banned: ${pubkey}`);
  }

  /**
   * Unban a previously banned peer.
   */
  unbanPeer(pubkey: string): void {
    this.db.prepare(`UPDATE peer_reputation SET is_banned = 0 WHERE peer_pubkey = ?`).run(pubkey);
    log.debug(`peer unbanned: ${pubkey}`);
  }

  /**
   * Check if a peer is banned.
   */
  isBanned(pubkey: string): boolean {
    const row = this.db
      .prepare(`SELECT is_banned FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(pubkey) as { is_banned: number } | undefined;
    return row?.is_banned === 1;
  }

  /**
   * Called when a skill arrives from a peer. Creates or updates the peer record.
   * Also logs to peer_activity_log for anomaly detection.
   */
  recordSkillReceived(peerPubkey: string, peerId: string): void {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT peer_pubkey FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(peerPubkey) as { peer_pubkey: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE peer_reputation
           SET skills_received = skills_received + 1, last_seen_at = ?, peer_id = ?
           WHERE peer_pubkey = ?`,
        )
        .run(now, peerId, peerPubkey);
    } else {
      this.db
        .prepare(
          `INSERT INTO peer_reputation
           (peer_pubkey, peer_id, skills_received, first_seen_at, last_seen_at, is_trusted)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(peerPubkey, peerId, now, now, this.trustList.includes(peerPubkey) ? 1 : 0);
    }

    // Log activity for anomaly detection
    this.logActivity(peerPubkey, "skill_received");

    // Record initial trust edge (neutral)
    this.recordTrustEdge("local", peerPubkey, 0.5);
  }

  /**
   * Called after an ingestion decision (accept or reject).
   * Also records a trust edge based on the outcome.
   */
  recordIngestionResult(peerPubkey: string, accepted: boolean): void {
    const col = accepted ? "skills_accepted" : "skills_rejected";
    this.db
      .prepare(`UPDATE peer_reputation SET ${col} = ${col} + 1 WHERE peer_pubkey = ?`)
      .run(peerPubkey);

    // Update trust edge based on outcome
    this.recordTrustEdge("local", peerPubkey, accepted ? 0.8 : 0.2);
  }

  /**
   * Update peer quality scores based on execution data for this peer's skills.
   */
  updatePeerQuality(peerPubkey: string): void {
    const peerMetrics = this.executionTracker.getPeerSkillMetrics(peerPubkey);
    if (peerMetrics.totalSkills === 0) return;

    const quality = peerMetrics.avgSuccessRate;
    const reputation = this.computeReputation(peerPubkey, quality);

    this.db
      .prepare(
        `UPDATE peer_reputation SET avg_skill_quality = ?, reputation_score = ? WHERE peer_pubkey = ?`,
      )
      .run(quality, reputation, peerPubkey);
  }

  /**
   * Get reputation record for a peer.
   */
  getReputation(peerPubkey: string): PeerReputation | null {
    const row = this.db
      .prepare(`SELECT * FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(peerPubkey) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToReputation(row);
  }

  /**
   * Compute dynamic trust level based on reputation score.
   */
  getTrustLevel(peerPubkey: string): TrustLevel {
    // Check ban first — takes absolute precedence
    const row = this.db
      .prepare(
        `SELECT reputation_score, is_trusted, is_banned, anomaly_flag FROM peer_reputation WHERE peer_pubkey = ?`,
      )
      .get(peerPubkey) as
      | { reputation_score: number; is_trusted: number; is_banned: number; anomaly_flag: number }
      | undefined;

    if (row?.is_banned === 1) return "banned";

    // Manual trust override
    if (this.trustList.includes(peerPubkey)) return "verified";

    if (!row) return "untrusted";

    // Cap anomalous peers at "provisional"
    if (row.anomaly_flag === 1) {
      const score = Number(row.reputation_score ?? 0.5);
      const isTrusted = row.is_trusted === 1;
      const level = this.computeTrustLevelFromScore(score, isTrusted);
      if (level === "trusted" || level === "verified") return "provisional";
      return level;
    }

    const isTrusted = row.is_trusted === 1;
    const score = Number(row.reputation_score ?? 0.5);
    return this.computeTrustLevelFromScore(score, isTrusted);
  }

  /**
   * Get numeric trust score (0–1) for a peer. Returns 0.5 for unknown peers.
   */
  getTrustScore(peerPubkey: string): number {
    const row = this.db
      .prepare(`SELECT reputation_score FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(peerPubkey) as { reputation_score: number } | undefined;
    return Number(row?.reputation_score ?? 0.5);
  }

  /** Plan 8: Store a peer's wallet address for revenue sharing. */
  updateWalletAddress(peerPubkey: string, walletAddress: string): void {
    try {
      this.db
        .prepare(`UPDATE peer_reputation SET wallet_address = ? WHERE peer_pubkey = ?`)
        .run(walletAddress, peerPubkey);
    } catch {
      /* column may not exist on older schemas */
    }
  }

  /**
   * Get network leaderboard sorted by reputation.
   */
  getLeaderboard(limit = 20): PeerReputation[] {
    const rows = this.db
      .prepare(`SELECT * FROM peer_reputation ORDER BY reputation_score DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToReputation(r));
  }

  /**
   * Rate a specific skill from a peer (for peer_skill_ratings table).
   */
  rateSkill(peerPubkey: string, skillCrystalId: string, rating: number): void {
    this.db
      .prepare(
        `INSERT INTO peer_skill_ratings (id, peer_pubkey, skill_crystal_id, rating, rated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), peerPubkey, skillCrystalId, rating, Date.now());
  }

  // ── EigenTrust (Task 6) ──

  /**
   * Record or update a trust edge between two parties.
   * Uses EMA to blend new weight with existing evidence.
   */
  recordTrustEdge(trusterPubkey: string, trusteePubkey: string, weight: number): void {
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT id, trust_weight, evidence_count FROM peer_trust_edges
         WHERE truster_pubkey = ? AND trustee_pubkey = ?`,
      )
      .get(trusterPubkey, trusteePubkey) as
      | { id: string; trust_weight: number; evidence_count: number }
      | undefined;

    if (existing) {
      // EMA blending: new = alpha * observation + (1-alpha) * previous
      const alpha = 0.3;
      const blended = alpha * weight + (1 - alpha) * existing.trust_weight;
      this.db
        .prepare(
          `UPDATE peer_trust_edges SET trust_weight = ?, evidence_count = evidence_count + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(blended, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO peer_trust_edges (id, truster_pubkey, trustee_pubkey, trust_weight, evidence_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(crypto.randomUUID(), trusterPubkey, trusteePubkey, weight, now, now);
    }
  }

  /**
   * Refresh EigenTrust scores by sending trust edges to the Rust orchestrator
   * for power iteration computation. Falls back to in-process JS if no bridge.
   */
  async refreshEigenTrustScores(orchestratorBridge?: OrchestratorBridgeLike | null): Promise<void> {
    const edges = this.db
      .prepare(`SELECT truster_pubkey, trustee_pubkey, trust_weight FROM peer_trust_edges`)
      .all() as Array<{ truster_pubkey: string; trustee_pubkey: string; trust_weight: number }>;

    if (edges.length === 0) return;

    const trustEdges: Array<[string, string, number]> = edges.map((e) => [
      e.truster_pubkey,
      e.trustee_pubkey,
      e.trust_weight,
    ]);

    const preTrusted = this.trustList;

    let scores: Record<string, number>;

    if (orchestratorBridge && "computeEigenTrust" in orchestratorBridge) {
      // Route to Rust orchestrator via IPC
      try {
        const result = await (
          orchestratorBridge as unknown as {
            computeEigenTrust(payload: unknown): Promise<{ scores: Record<string, number> }>;
          }
        ).computeEigenTrust({
          trust_edges: trustEdges,
          pre_trusted: preTrusted,
          max_iterations: 7,
        });
        scores = result.scores;
      } catch (err) {
        log.debug(`EigenTrust IPC failed, falling back to JS: ${String(err)}`);
        scores = this.computeEigenTrustLocal(trustEdges, preTrusted, 7);
      }
    } else {
      // Fallback: in-process JS computation
      scores = this.computeEigenTrustLocal(trustEdges, preTrusted, 7);
    }

    // Batch-update eigentrust_score column
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE peer_reputation SET eigentrust_score = ?, last_eigentrust_at = ? WHERE peer_pubkey = ?`,
    );
    for (const [pubkey, score] of Object.entries(scores)) {
      stmt.run(score, now, pubkey);
    }

    log.debug(`EigenTrust scores refreshed for ${Object.keys(scores).length} peers`);
  }

  /**
   * Lightweight in-process EigenTrust computation (same algorithm as Rust).
   * Suitable for small meshes; for large meshes prefer the Rust IPC path.
   */
  private computeEigenTrustLocal(
    edges: Array<[string, string, number]>,
    preTrusted: string[],
    maxIterations: number,
  ): Record<string, number> {
    // Collect all peers
    const peerSet = new Set<string>();
    for (const [a, b] of edges) {
      peerSet.add(a);
      peerSet.add(b);
    }
    const peers = Array.from(peerSet);
    const n = peers.length;
    if (n === 0) return {};

    const idx = new Map<string, number>();
    peers.forEach((p, i) => idx.set(p, i));

    // Build row-normalized trust matrix C
    const C = Array.from({ length: n }, () => new Float64Array(n));
    const rowSums = new Float64Array(n);

    for (const [truster, trustee, weight] of edges) {
      const i = idx.get(truster)!;
      const j = idx.get(trustee)!;
      const w = Math.max(0, weight);
      C[i]![j] += w;
      rowSums[i] += w;
    }

    // Row-normalize
    for (let i = 0; i < n; i++) {
      if (rowSums[i] > 0) {
        for (let j = 0; j < n; j++) {
          C[i]![j] /= rowSums[i];
        }
      }
    }

    // Pre-trust vector p
    const p = new Float64Array(n).fill(1 / n);
    if (preTrusted.length > 0) {
      p.fill(0);
      for (const pk of preTrusted) {
        const i = idx.get(pk);
        if (i !== undefined) p[i] = 1 / preTrusted.length;
      }
    }

    // Power iteration: t_new = 0.9 * C^T * t + 0.1 * p
    let t = new Float64Array(n).fill(1 / n);
    const convergenceThreshold = 0.001;

    for (let iter = 0; iter < maxIterations; iter++) {
      const tNew = new Float64Array(n);
      // C^T * t
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          tNew[j] += C[i]![j] * t[i]!;
        }
      }
      // Blend: 0.9 * C^T*t + 0.1 * p
      for (let i = 0; i < n; i++) {
        tNew[i] = 0.9 * tNew[i]! + 0.1 * p[i]!;
      }

      // Check convergence
      let maxDiff = 0;
      for (let i = 0; i < n; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(tNew[i]! - t[i]!));
      }

      t = tNew;
      if (maxDiff < convergenceThreshold) break;
    }

    const scores: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      scores[peers[i]!] = t[i]!;
    }
    return scores;
  }

  /**
   * Detect anomalous peers based on recent activity rate spikes.
   * Flags peers with >3x their historical average skill publication rate.
   */
  detectAnomalies(windowMs = 3_600_000): void {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Get recent activity counts per peer
    const recentCounts = this.db
      .prepare(
        `SELECT peer_pubkey, COUNT(*) as c FROM peer_activity_log
         WHERE event_type = 'skill_received' AND timestamp > ?
         GROUP BY peer_pubkey`,
      )
      .all(cutoff) as Array<{ peer_pubkey: string; c: number }>;

    for (const { peer_pubkey, c: recentCount } of recentCounts) {
      // Get total historical count and age
      const rep = this.db
        .prepare(`SELECT skills_received, first_seen_at FROM peer_reputation WHERE peer_pubkey = ?`)
        .get(peer_pubkey) as { skills_received: number; first_seen_at: number } | undefined;

      if (!rep) continue;

      const ageMs = Math.max(windowMs, now - rep.first_seen_at);
      const windowCount = Math.ceil(ageMs / windowMs);
      const avgPerWindow = rep.skills_received / Math.max(1, windowCount);

      // Flag if >3x average
      const isAnomaly = recentCount > 3 * Math.max(1, avgPerWindow);
      this.db
        .prepare(`UPDATE peer_reputation SET anomaly_flag = ? WHERE peer_pubkey = ?`)
        .run(isAnomaly ? 1 : 0, peer_pubkey);

      if (isAnomaly) {
        log.debug(
          `anomaly flagged: peer ${peer_pubkey} published ${recentCount} skills in window (avg: ${avgPerWindow.toFixed(1)})`,
        );
      }
    }
  }

  private computeReputation(peerPubkey: string, quality: number): number {
    const row = this.db
      .prepare(
        `SELECT skills_received, skills_accepted, first_seen_at, eigentrust_score
         FROM peer_reputation WHERE peer_pubkey = ?`,
      )
      .get(peerPubkey) as
      | {
          skills_received: number;
          skills_accepted: number;
          first_seen_at: number;
          eigentrust_score: number | null;
        }
      | undefined;

    if (!row) return 0.5;

    const acceptanceRate = row.skills_accepted / Math.max(1, row.skills_received);
    const daysSinceFirst = (Date.now() - row.first_seen_at) / (1000 * 60 * 60 * 24);
    const longevityFactor = Math.min(1, daysSinceFirst / 30);

    const localScore = 0.4 * acceptanceRate + 0.4 * quality + 0.2 * longevityFactor;

    // Blend with EigenTrust score if available
    const eigenScore = row.eigentrust_score ?? 0.5;
    return 0.7 * localScore + 0.3 * eigenScore;
  }

  /**
   * Compute trust level from a score and trusted flag without DB lookup.
   */
  private computeTrustLevelFromScore(score: number, isTrusted: boolean): TrustLevel {
    if (isTrusted) return "verified";
    if (score >= 0.85) return "verified";
    if (score >= 0.6) return "trusted";
    if (score >= 0.3) return "provisional";
    return "untrusted";
  }

  private rowToReputation(row: Record<string, unknown>): PeerReputation {
    const peerPubkey = String(row.peer_pubkey ?? "");
    const isBanned = row.is_banned === 1;
    const isTrusted = !isBanned && (row.is_trusted === 1 || this.trustList.includes(peerPubkey));
    const reputationScore = Number(row.reputation_score ?? 0.5);

    let trustLevel: TrustLevel;
    if (isBanned) {
      trustLevel = "banned";
    } else {
      trustLevel = this.computeTrustLevelFromScore(reputationScore, isTrusted);
    }

    return {
      peerPubkey,
      peerId: row.peer_id ? String(row.peer_id) : null,
      displayName: row.display_name ? String(row.display_name) : null,
      skillsReceived: Number(row.skills_received ?? 0),
      skillsAccepted: Number(row.skills_accepted ?? 0),
      skillsRejected: Number(row.skills_rejected ?? 0),
      avgSkillQuality: Number(row.avg_skill_quality ?? 0),
      reputationScore,
      firstSeenAt: Number(row.first_seen_at ?? 0),
      lastSeenAt: Number(row.last_seen_at ?? 0),
      isTrusted,
      trustLevel,
    };
  }

  /**
   * Log a peer activity event for anomaly detection.
   */
  private logActivity(peerPubkey: string, eventType: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO peer_activity_log (id, peer_pubkey, event_type, timestamp) VALUES (?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), peerPubkey, eventType, Date.now());
    } catch {
      // Non-critical
    }
  }

  // ── Phase 5A: Category-Based Trust Scoring ──────────────────────────

  /**
   * Record a category-specific trust score for a peer.
   * Called when a peer's skill is executed and rated by the local agent.
   */
  recordCategoryTrust(
    peerPubkey: string,
    category: string,
    success: boolean,
    quality: number,
  ): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_category_reputation (
          pubkey TEXT NOT NULL,
          category TEXT NOT NULL,
          score REAL DEFAULT 0.5,
          evidence_count INTEGER DEFAULT 0,
          last_updated INTEGER,
          PRIMARY KEY (pubkey, category)
        )
      `);

      const existing = this.db
        .prepare(
          `SELECT score, evidence_count FROM peer_category_reputation WHERE pubkey = ? AND category = ?`,
        )
        .get(peerPubkey, category) as { score: number; evidence_count: number } | undefined;

      const newEvidence = success ? quality : quality * 0.3;
      if (existing) {
        // Exponential moving average: 0.7 * old + 0.3 * new
        const updated = 0.7 * existing.score + 0.3 * newEvidence;
        this.db
          .prepare(
            `UPDATE peer_category_reputation SET score = ?, evidence_count = ?, last_updated = ? WHERE pubkey = ? AND category = ?`,
          )
          .run(updated, existing.evidence_count + 1, Date.now(), peerPubkey, category);
      } else {
        this.db
          .prepare(
            `INSERT INTO peer_category_reputation (pubkey, category, score, evidence_count, last_updated) VALUES (?, ?, ?, 1, ?)`,
          )
          .run(peerPubkey, category, newEvidence, Date.now());
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Get category-specific reputation for a peer.
   * Returns overall reputation if no category specified.
   */
  getCategoryReputation(peerPubkey: string, category?: string): number {
    if (!category) {
      return this.getReputation(peerPubkey)?.reputationScore ?? 0.5;
    }
    try {
      const row = this.db
        .prepare(`SELECT score FROM peer_category_reputation WHERE pubkey = ? AND category = ?`)
        .get(peerPubkey, category) as { score: number } | undefined;
      return row?.score ?? 0.5;
    } catch {
      return 0.5;
    }
  }

  // ── Phase 5B: Execution Verification ────────────────────────────────

  /**
   * Record execution outcome for a peer's skill and update trust.
   * Called after executing an ingested skill to verify it actually works.
   */
  recordSkillExecutionVerification(
    authorPubkey: string,
    skillCategory: string,
    success: boolean,
    rewardScore: number,
  ): void {
    // Update overall trust edge based on execution outcome
    const weight = success
      ? Math.min(1.0, 0.5 + rewardScore * 0.5)
      : Math.max(0.0, 0.3 - rewardScore * 0.3);
    this.recordTrustEdge("local", authorPubkey, weight);

    // Update category-specific trust
    this.recordCategoryTrust(authorPubkey, skillCategory, success, rewardScore);

    this.logActivity(authorPubkey, success ? "skill_execution_success" : "skill_execution_failure");
  }

  // ── Phase 7A: Peer-to-Peer Anomaly Reports ─────────────────────────

  /**
   * Record an anomaly report from another edge node.
   * If N independent reporters flag the same peer, reduce trust.
   */
  recordPeerAnomalyReport(reporterPubkey: string, targetPubkey: string, reason: string): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_anomaly_reports (
          id TEXT PRIMARY KEY,
          reporter_pubkey TEXT NOT NULL,
          target_pubkey TEXT NOT NULL,
          reason TEXT,
          reported_at INTEGER NOT NULL
        )
      `);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_anomaly_target ON peer_anomaly_reports(target_pubkey)`,
      );

      this.db
        .prepare(
          `INSERT INTO peer_anomaly_reports (id, reporter_pubkey, target_pubkey, reason, reported_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), reporterPubkey, targetPubkey, reason, Date.now());

      // Count unique reporters for this target in last hour
      const cutoff = Date.now() - 3600000;
      const count =
        (
          this.db
            .prepare(
              `SELECT COUNT(DISTINCT reporter_pubkey) as c FROM peer_anomaly_reports WHERE target_pubkey = ? AND reported_at > ?`,
            )
            .get(targetPubkey, cutoff) as { c: number }
        )?.c ?? 0;

      // If 3+ independent reporters flag the same peer, reduce trust
      if (count >= 3) {
        const rep = this.getReputation(targetPubkey);
        if (rep && rep.reputationScore > 0.1) {
          const newScore = Math.max(0.0, rep.reputationScore - 0.1 * count);
          this.db
            .prepare(
              `UPDATE peer_reputation SET reputation_score = ?, trust_level = ? WHERE peer_pubkey = ?`,
            )
            .run(newScore, newScore < 0.3 ? "untrusted" : "provisional", targetPubkey);
        }
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Get anomaly reports for a peer.
   */
  getAnomalyReports(
    targetPubkey: string,
    limit = 50,
  ): Array<{ reporter: string; reason: string; reportedAt: number }> {
    try {
      return this.db
        .prepare(
          `SELECT reporter_pubkey as reporter, reason, reported_at as reportedAt
         FROM peer_anomaly_reports WHERE target_pubkey = ? ORDER BY reported_at DESC LIMIT ?`,
        )
        .all(targetPubkey, limit) as Array<{
        reporter: string;
        reason: string;
        reportedAt: number;
      }>;
    } catch {
      return [];
    }
  }
}
