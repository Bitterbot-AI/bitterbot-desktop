/**
 * Economy doctor section: the money-moving surfaces (Forage bounties,
 * marketplace revenue, the A2A x402 payment gate) had ZERO doctor coverage
 * despite handling real USDC. The failure modes are all silent-by-design:
 *
 *   - A judge pass above the unilateral cap parks a settlement at
 *     'held_review'; it moves ONLY when a human runs forage.reviewRelease,
 *     and nothing told the human money was parked.
 *   - Revenue shares sit in revenue_payment_queue behind a 48h dispute
 *     window; a wedged release sweep or a failing payout leaves them
 *     overdue forever.
 *   - a2a.payment.enabled DERIVES from wallet credentials (isEarningCapable),
 *     so adding CDP creds silently arms the 402 gate; if the node then has
 *     no receive address, peers get charged with nowhere to pay.
 *
 * All warn/info: parked money and config traps are operator-attention state,
 * not build breakage, so they must never block the update gate.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isEarningCapable } from "../config/defaults.js";
import { renderSectionQuietIfAllInfo, type CheckResult, ok, warn, info } from "./doctor-check.js";
import { resolveDoctorMemoryDbPath } from "./doctor-subsystems.js";

const SECTION = "Economy (Forage / Marketplace / A2A)";
// Slack past release_at before a held revenue row counts as overdue: the
// release sweep runs periodically, so a just-expired window is not a fault.
const RELEASE_OVERDUE_SLACK_MS = 6 * 60 * 60_000;
// A settlement approved for payout (or a released revenue row) untouched this
// long means the payout loop is not doing its job.
const QUEUED_STUCK_MS = 24 * 60 * 60_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
  );
}

/**
 * Pure ledger inspection on an open DB — exported for tests.
 *
 * Stuck-in-motion states ("sweep not running", "payout never attempted")
 * warn only when the gateway is RUNNING: those loops live in the gateway, so
 * on a stopped node a backlog is expected, not a fault. Parked-for-human
 * states (held_review) and recorded payout errors warn regardless — they
 * need a person no matter what the process is doing.
 */
export function inspectEconomyLedgers(
  db: DatabaseSync,
  isGatewayRunning: boolean,
  now: number = Date.now(),
): CheckResult[] {
  const results: CheckResult[] = [];

  // ── Forage settlements ──
  if (tableExists(db, "bounty_settlements")) {
    try {
      const held = db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(SUM(amount_usdc), 0) AS usdc
             FROM bounty_settlements WHERE status = 'held_review'`,
        )
        .get() as { c: number; usdc: number };
      if (held.c > 0) {
        results.push(
          warn(
            `${held.c} bounty settlement(s) totaling $${held.usdc.toFixed(2)} USDC parked at ` +
              `held_review — this money does not move until a human reviews it. ` +
              `Inspect via the forage.review RPC (Control UI operator surface).`,
          ),
        );
      }
      // Approved settlements stuck in the payout pipeline.
      const stuckQueued = db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(SUM(amount_usdc), 0) AS usdc
             FROM bounty_settlements WHERE status = 'queued' AND created_at < ?`,
        )
        .get(now - QUEUED_STUCK_MS) as { c: number; usdc: number };
      if (stuckQueued.c > 0 && isGatewayRunning) {
        results.push(
          warn(
            `${stuckQueued.c} approved settlement(s) totaling $${stuckQueued.usdc.toFixed(2)} USDC ` +
              `queued for payout for >24h — the payout runner or wallet may be down.`,
          ),
        );
      }
      let errored = 0;
      try {
        errored = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM bounty_settlements
                WHERE error IS NOT NULL AND status NOT IN ('paid')`,
            )
            .get() as { c: number }
        ).c;
      } catch {
        // error column absent on older schemas
      }
      if (errored > 0) {
        results.push(warn(`${errored} bounty settlement(s) carry a payout error — check wallet.`));
      }
      if (held.c === 0 && errored === 0 && (stuckQueued.c === 0 || !isGatewayRunning)) {
        results.push(ok("No bounty settlements parked, stuck, or errored."));
      }
    } catch (err) {
      results.push(info(`Could not read bounty_settlements: ${String(err)}`));
    }
  } else {
    results.push(info("Forage ledger tables absent (pre-PLAN-29 DB or forage never used)."));
  }

  // ── Marketplace revenue queue ──
  if (tableExists(db, "revenue_payment_queue")) {
    try {
      const overdue = db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(SUM(amount_usdc), 0) AS usdc
             FROM revenue_payment_queue WHERE status = 'held' AND release_at < ?`,
        )
        .get(now - RELEASE_OVERDUE_SLACK_MS) as { c: number; usdc: number };
      if (overdue.c > 0 && isGatewayRunning) {
        results.push(
          warn(
            `${overdue.c} revenue payment(s) totaling $${overdue.usdc.toFixed(2)} USDC are past ` +
              `their dispute window but still 'held' — the release sweep may not be running.`,
          ),
        );
      }
      const failed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM revenue_payment_queue
            WHERE status = 'released' AND error IS NOT NULL`,
        )
        .get() as { c: number };
      if (failed.c > 0) {
        results.push(
          warn(`${failed.c} revenue payment(s) released but errored during payout — check wallet.`),
        );
      }
      // Released, never errored, never processed: the payout loop has not even
      // attempted them (e.g. no wallet credentials, loop not running).
      const neverPaid = db
        .prepare(
          `SELECT COUNT(*) AS c FROM revenue_payment_queue
            WHERE status = 'released' AND error IS NULL AND processed_at IS NULL
              AND release_at < ?`,
        )
        .get(now - QUEUED_STUCK_MS) as { c: number };
      if (neverPaid.c > 0 && isGatewayRunning) {
        results.push(
          warn(
            `${neverPaid.c} released revenue payment(s) have waited >24h with no payout attempt — ` +
              `the payout loop may not be running (wallet credentials?).`,
          ),
        );
      }
      const disputed = db
        .prepare(`SELECT COUNT(*) AS c FROM revenue_payment_queue WHERE status = 'disputed'`)
        .get() as { c: number };
      if (disputed.c > 0) {
        results.push(info(`${disputed.c} revenue payment(s) under dispute.`));
      }
      if (failed.c === 0 && (!isGatewayRunning || (overdue.c === 0 && neverPaid.c === 0))) {
        results.push(ok("Revenue payment queue: nothing overdue or failed."));
      }
    } catch (err) {
      results.push(info(`Could not read revenue_payment_queue: ${String(err)}`));
    }
  }

  return results;
}

/** Pure config inspection — exported for tests. */
export function inspectEconomyConfig(cfg: BitterbotConfig): CheckResult[] {
  const results: CheckResult[] = [];

  // ── A2A x402 payment gate ──
  const explicitEnabled = cfg.a2a?.payment?.enabled;
  const earning = isEarningCapable(cfg);
  const effectiveEnabled = explicitEnabled ?? earning;
  const address = cfg.a2a?.payment?.x402?.address?.trim();
  if (effectiveEnabled) {
    if (address && !EVM_ADDRESS.test(address)) {
      results.push(
        warn(
          `a2a.payment.x402.address "${address}" is not a valid EVM address — inbound x402 ` +
            `payments will verify against a recipient that cannot exist.`,
        ),
      );
    } else if (!address && !earning) {
      // Only reachable via explicit payment.enabled=true: the gate will 402
      // every paid call and there is no wallet to derive a receive address from.
      results.push(
        warn(
          "a2a.payment.enabled is true but the node has no wallet credentials and no " +
            "x402 receive address — every inbound paid call will 402 with nowhere to pay. " +
            `Set one: ${formatCliCommand('bitterbot config set a2a.payment.x402.address "0x…"')}`,
        ),
      );
    } else if (!address) {
      results.push(
        info(
          "A2A payment gate is ON; the x402 receive address derives from the live wallet " +
            "at verification time. Set a2a.payment.x402.address to pin it.",
        ),
      );
    } else {
      results.push(ok(`A2A payment gate ON, receive address ${address.slice(0, 10)}….`));
    }
  } else {
    results.push(info("A2A payment gate off (no wallet credentials, not explicitly enabled)."));
  }

  // ── Public A2A endpoint without auth ──
  if (cfg.a2a?.enabled !== false && cfg.a2a?.url && cfg.a2a?.authentication?.type === "none") {
    results.push(
      warn(
        `A2A server advertises a public URL (${cfg.a2a.url}) with authentication "none" — ` +
          "any peer can submit tasks to this node.",
      ),
    );
  }

  // ── Forage Night Shift posture ──
  const nightShift = cfg.forage?.nightShift?.enabled !== false;
  if (nightShift && !earning) {
    results.push(
      info(
        "Forage Night Shift is enabled (default) but the node has no wallet credentials — " +
          "it can hunt bounties but cannot be paid for them.",
      ),
    );
  }

  return results;
}

export function runEconomyChecks(params: {
  config: BitterbotConfig;
  isGatewayRunning: boolean;
}): void {
  const cfg = params.config;
  const results: CheckResult[] = [...inspectEconomyConfig(cfg)];

  const dbPath = resolveDoctorMemoryDbPath(cfg);
  if (dbPath && fs.existsSync(dbPath)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      results.push(...inspectEconomyLedgers(db, params.isGatewayRunning));
    } catch (err) {
      results.push(info(`Could not open memory DB for ledger checks: ${String(err)}`));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Quiet when posture-only (fresh install: gate off, no ledgers):
  // recorded, not printed (PLAN-41 p0-28).
  renderSectionQuietIfAllInfo(SECTION, results);
}
