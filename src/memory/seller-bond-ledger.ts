/**
 * PLAN-43 Phase 3 (§3.7): the slashable seller bond as a LEDGER.
 *
 * Money never moves here (invariant I7: every fund-moving path stays
 * flag-off pending payments counsel). A bond row records that a seller
 * has a stake at risk; a SLASH row records that validated fraud consumed
 * it. What makes fraud "validated" is this node's OWN attestation: a
 * peer-origin skill from that seller re-scored on this node's corpus with
 * a regression verdict (it breaks tasks the incumbent passes). A seller
 * whose bond is slashed is also commerce-quarantined, so the A2A client
 * stops spending on them.
 *
 * Posting a bond is an operator action (RPC); nothing auto-posts.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { CommerceReputationLedger, commercePubkeyKey } from "./commerce-reputation.js";
import {
  ensureAttestationSchema,
  listAttestations,
  skillContentSha256,
} from "./skill-evolution/attestation.js";

export type BondStatus = "posted" | "slashed" | "released";

export interface SellerBond {
  id: string;
  sellerPubkey: string;
  amountUsdc: number;
  status: BondStatus;
  reason: string | null;
  evidence: unknown;
  createdAt: number;
  updatedAt: number;
}

export const FRAUD_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000;

export class SellerBondLedger {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_bonds (
        id TEXT PRIMARY KEY,
        seller_pubkey TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        evidence_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_seller_bonds_seller ON seller_bonds(seller_pubkey);
      CREATE TABLE IF NOT EXISTS fraud_verdicts (
        content_sha256 TEXT NOT NULL,
        seller_pubkey TEXT NOT NULL,
        attester_pubkey TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (content_sha256, seller_pubkey, attester_pubkey)
      );
    `);
  }

  /** Ledger entry only: no funds move. */
  postBond(sellerPubkey: string, amountUsdc: number, now: number = Date.now()): SellerBond {
    if (!(amountUsdc > 0) || !Number.isFinite(amountUsdc)) {
      throw new Error("bond amount must be positive");
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO seller_bonds (id, seller_pubkey, amount_usdc, status, created_at, updated_at)
         VALUES (?, ?, ?, 'posted', ?, ?)`,
      )
      .run(id, sellerPubkey, amountUsdc, now, now);
    return this.get(id)!;
  }

  releaseBond(id: string, now: number = Date.now()): boolean {
    const r = this.db
      .prepare(
        `UPDATE seller_bonds SET status = 'released', updated_at = ? WHERE id = ? AND status = 'posted'`,
      )
      .run(now, id) as { changes: number };
    return r.changes > 0;
  }

  /** Slash every POSTED bond of a seller. Returns the number slashed. */
  slashSeller(
    sellerPubkey: string,
    reason: string,
    evidence: unknown,
    now: number = Date.now(),
  ): number {
    const r = this.db
      .prepare(
        `UPDATE seller_bonds SET status = 'slashed', reason = ?, evidence_json = ?, updated_at = ?
          WHERE seller_pubkey = ? AND status = 'posted'`,
      )
      .run(
        reason.slice(0, 200),
        JSON.stringify(evidence ?? null).slice(0, 4000),
        now,
        sellerPubkey,
      ) as {
      changes: number;
    };
    return r.changes;
  }

  get(id: string): SellerBond | null {
    const row = this.db.prepare(`SELECT * FROM seller_bonds WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToBond(row) : null;
  }

  list(sellerPubkey?: string, limit = 50): SellerBond[] {
    const rows = (
      sellerPubkey
        ? this.db
            .prepare(
              `SELECT * FROM seller_bonds WHERE seller_pubkey = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(sellerPubkey, limit)
        : this.db.prepare(`SELECT * FROM seller_bonds ORDER BY created_at DESC LIMIT ?`).all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToBond);
  }

  summary(): {
    posted: number;
    slashed: number;
    released: number;
    atRiskUsdc: number;
    fraudVerdicts: number;
    sellersWithVerdicts: string[];
  } {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount_usdc), 0) AS s FROM seller_bonds GROUP BY status`,
      )
      .all() as Array<{ status: BondStatus; c: number; s: number }>;
    const out = {
      posted: 0,
      slashed: 0,
      released: 0,
      atRiskUsdc: 0,
      fraudVerdicts: 0,
      sellersWithVerdicts: [] as string[],
    };
    for (const r of rows) {
      out[r.status] = r.c;
      if (r.status === "posted") {
        out.atRiskUsdc = r.s;
      }
    }
    const verdicts = this.db
      .prepare(`SELECT seller_pubkey, COUNT(*) AS c FROM fraud_verdicts GROUP BY seller_pubkey`)
      .all() as Array<{ seller_pubkey: string; c: number }>;
    out.fraudVerdicts = verdicts.reduce((a, v) => a + v.c, 0);
    out.sellersWithVerdicts = verdicts.map((v) => v.seller_pubkey).slice(0, 50);
    return out;
  }

  /**
   * Validated fraud = THIS node's own regression attestation on a
   * peer-origin skill. For every such (skill, seller) not yet recorded:
   * record the verdict, slash the seller's posted bonds, and quarantine
   * the seller's commerce standing. Idempotent per (skill, seller).
   */
  applyRegressionVerdicts(params: {
    ownAttesterPubkey: string;
    commerce?: CommerceReputationLedger;
    now?: number;
  }): { verdicts: number; sellersSlashed: string[] } {
    const now = params.now ?? Date.now();
    ensureAttestationSchema(this.db);
    // Cheap pre-check: only skills WE attested as regressions can matter.
    const ownRegressions = new Set(
      (
        this.db
          .prepare(
            `SELECT content_sha256 FROM skill_attestations WHERE attester_pubkey = ? AND verdict = 'regression'`,
          )
          .all(params.ownAttesterPubkey) as Array<{ content_sha256: string }>
      ).map((r) => r.content_sha256),
    );
    if (ownRegressions.size === 0) {
      return { verdicts: 0, sellersSlashed: [] };
    }
    const rows = this.db
      .prepare(
        `SELECT text, governance_json FROM chunks
          WHERE semantic_type IN ('skill', 'task_pattern')
            AND governance_json LIKE '%"peerOrigin"%'
            AND COALESCE(deprecated, 0) = 0
          ORDER BY updated_at DESC
          LIMIT 2000`,
      )
      .all() as Array<{ text: string; governance_json: string | null }>;
    let verdicts = 0;
    const sellers = new Set<string>();
    for (const row of rows) {
      let seller = "";
      try {
        const g = JSON.parse(row.governance_json ?? "{}") as { peerOrigin?: unknown };
        seller = typeof g.peerOrigin === "string" ? g.peerOrigin : "";
      } catch {
        /* ignore */
      }
      if (!seller) {
        continue;
      }
      const sha = skillContentSha256(row.text);
      if (!ownRegressions.has(sha)) {
        continue;
      }
      const all = listAttestations(this.db, sha);
      const mine = all.find(
        (a) => a.attester_pubkey === params.ownAttesterPubkey && a.verdict === "regression",
      );
      if (!mine) {
        continue;
      }
      // Regression EVIDENCE, corroborated: a single failing private task
      // can be a distraction effect, not fraud. Require either a second
      // failing task in our own verdict or another attester's regression.
      const corroborated =
        mine.regressions >= 2 ||
        all.some(
          (a) => a.attester_pubkey !== params.ownAttesterPubkey && a.verdict === "regression",
        );
      if (!corroborated) {
        continue;
      }
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO fraud_verdicts (content_sha256, seller_pubkey, attester_pubkey, recorded_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sha, seller, params.ownAttesterPubkey, now) as { changes: number };
      if (inserted.changes === 0) {
        continue;
      }
      verdicts += 1;
      sellers.add(seller);
      this.slashSeller(
        seller,
        "regression attested on this node",
        { contentSha256: sha, regressions: mine.regressions, attestedAt: mine.attested_at },
        now,
      );
      params.commerce?.quarantine(
        commercePubkeyKey(seller),
        now + FRAUD_QUARANTINE_MS,
        `regression attested on skill ${sha.slice(0, 12)}`,
      );
    }
    return { verdicts, sellersSlashed: [...sellers] };
  }
}

function rowToBond(row: Record<string, unknown>): SellerBond {
  let evidence: unknown = null;
  try {
    evidence =
      typeof row.evidence_json === "string" && row.evidence_json
        ? JSON.parse(row.evidence_json)
        : null;
  } catch {
    evidence = null;
  }
  return {
    id: String(row.id),
    sellerPubkey: String(row.seller_pubkey),
    amountUsdc: Number(row.amount_usdc),
    status: String(row.status) as BondStatus,
    reason: (row.reason as string | null) ?? null,
    evidence,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
