import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { inspectEconomyConfig, inspectEconomyLedgers } from "./doctor-economy.js";

const NOW = 1_750_000_000_000;

function ledgerDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE bounty_settlements (
      id TEXT PRIMARY KEY, bounty_id TEXT, claim_id TEXT, hunter_pubkey TEXT,
      hunter_wallet TEXT, amount_usdc REAL, status TEXT, error TEXT, created_at INTEGER
    );
    CREATE TABLE revenue_payment_queue (
      id TEXT PRIMARY KEY, skill_crystal_id TEXT, purchase_id TEXT,
      recipient_peer_id TEXT, amount_usdc REAL, role TEXT,
      status TEXT NOT NULL DEFAULT 'held', dispute_reason TEXT, tx_hash TEXT,
      error TEXT, queued_at INTEGER, release_at INTEGER, processed_at INTEGER
    );
  `);
  return db;
}

describe("inspectEconomyLedgers", () => {
  it("warns on settlements parked at held_review with the dollar total", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO bounty_settlements (id, amount_usdc, status, created_at) VALUES (?, ?, ?, ?)`,
    ).run("s1", 1.5, "held_review", NOW);
    db.prepare(
      `INSERT INTO bounty_settlements (id, amount_usdc, status, created_at) VALUES (?, ?, ?, ?)`,
    ).run("s2", 0.75, "paid", NOW);
    const results = inspectEconomyLedgers(db, true, NOW);
    const held = results.find((r) => r.level === "warn" && /held_review/.test(r.message));
    expect(held).toBeTruthy();
    expect(held?.message).toContain("1 bounty settlement(s)");
    expect(held?.message).toContain("$1.50");
    db.close();
  });

  it("ok when nothing is parked", () => {
    const db = ledgerDb();
    const results = inspectEconomyLedgers(db, true, NOW);
    expect(
      results.some((r) => r.level === "ok" && /No bounty settlements parked/.test(r.message)),
    ).toBe(true);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("warns on revenue payments overdue past the dispute window", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO revenue_payment_queue (id, skill_crystal_id, purchase_id, recipient_peer_id,
        amount_usdc, role, status, queued_at, release_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "r1",
      "c1",
      "p1",
      "peer",
      2.0,
      "author",
      "held",
      NOW - 90 * 60 * 60_000,
      NOW - 24 * 60 * 60_000,
    );
    const results = inspectEconomyLedgers(db, true, NOW);
    expect(
      results.some(
        (r) =>
          r.level === "warn" &&
          /past\s+their dispute window|past their dispute window/s.test(r.message),
      ),
    ).toBe(true);
    db.close();
  });

  it("does not warn on a held payment still inside its window", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO revenue_payment_queue (id, skill_crystal_id, purchase_id, recipient_peer_id,
        amount_usdc, role, status, queued_at, release_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r1", "c1", "p1", "peer", 2.0, "author", "held", NOW, NOW + 48 * 60 * 60_000);
    const results = inspectEconomyLedgers(db, true, NOW);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("warns on released payments that errored during payout", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO revenue_payment_queue (id, skill_crystal_id, purchase_id, recipient_peer_id,
        amount_usdc, role, status, error, queued_at, release_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r1", "c1", "p1", "peer", 2.0, "author", "released", "insufficient gas", NOW, NOW);
    const results = inspectEconomyLedgers(db, true, NOW);
    expect(results.some((r) => r.level === "warn" && /errored during payout/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("warns on approved settlements stuck at queued for >24h (gateway running)", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO bounty_settlements (id, amount_usdc, status, created_at) VALUES (?, ?, ?, ?)`,
    ).run("s1", 3.0, "queued", NOW - 2 * 24 * 60 * 60_000);
    const running = inspectEconomyLedgers(db, true, NOW);
    expect(running.some((r) => r.level === "warn" && /queued for payout/.test(r.message))).toBe(
      true,
    );
    // Gateway down: the payout runner cannot run — expected, not a fault.
    const stopped = inspectEconomyLedgers(db, false, NOW);
    expect(stopped.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("warns on settlements carrying a payout error regardless of gateway state", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO bounty_settlements (id, amount_usdc, status, error, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", 3.0, "queued", "insufficient gas", NOW);
    const results = inspectEconomyLedgers(db, false, NOW);
    expect(results.some((r) => r.level === "warn" && /payout error/.test(r.message))).toBe(true);
    db.close();
  });

  it("warns on released revenue rows never attempted for >24h (gateway running)", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO revenue_payment_queue (id, skill_crystal_id, purchase_id, recipient_peer_id,
        amount_usdc, role, status, queued_at, release_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "r1",
      "c1",
      "p1",
      "peer",
      2.0,
      "author",
      "released",
      NOW - 3 * 24 * 60 * 60_000,
      NOW - 2 * 24 * 60 * 60_000,
    );
    const running = inspectEconomyLedgers(db, true, NOW);
    expect(running.some((r) => r.level === "warn" && /no payout attempt/.test(r.message))).toBe(
      true,
    );
    const stopped = inspectEconomyLedgers(db, false, NOW);
    expect(stopped.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("does not warn on held-overdue when the gateway is down (sweep cannot run)", () => {
    const db = ledgerDb();
    db.prepare(
      `INSERT INTO revenue_payment_queue (id, skill_crystal_id, purchase_id, recipient_peer_id,
        amount_usdc, role, status, queued_at, release_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "r1",
      "c1",
      "p1",
      "peer",
      2.0,
      "author",
      "held",
      NOW - 90 * 60 * 60_000,
      NOW - 24 * 60 * 60_000,
    );
    const stopped = inspectEconomyLedgers(db, false, NOW);
    expect(stopped.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("reports absent forage tables as info (pre-PLAN-29 DB)", () => {
    const db = new DatabaseSync(":memory:");
    const results = inspectEconomyLedgers(db, true, NOW);
    expect(
      results.some((r) => r.level === "info" && /Forage ledger tables absent/.test(r.message)),
    ).toBe(true);
    db.close();
  });
});

describe("inspectEconomyConfig", () => {
  it("warns when payment gate is explicitly on with no wallet and no address", () => {
    const cfg = { a2a: { payment: { enabled: true } } } as unknown as BitterbotConfig;
    const results = inspectEconomyConfig(cfg);
    expect(
      results.some((r) => r.level === "warn" && /402 with nowhere to pay/.test(r.message)),
    ).toBe(true);
  });

  it("warns on a malformed x402 address", () => {
    const cfg = {
      a2a: { payment: { enabled: true, x402: { address: "not-an-address" } } },
    } as unknown as BitterbotConfig;
    const results = inspectEconomyConfig(cfg);
    expect(
      results.some((r) => r.level === "warn" && /not a valid EVM address/.test(r.message)),
    ).toBe(true);
  });

  it("ok with a valid explicit address", () => {
    const cfg = {
      a2a: {
        payment: { enabled: true, x402: { address: "0x1593aFf88F7B3Ec456e2c1E1c723B7B090C1a2b3" } },
      },
    } as unknown as BitterbotConfig;
    const results = inspectEconomyConfig(cfg);
    expect(results.some((r) => r.level === "ok" && /payment gate ON/i.test(r.message))).toBe(true);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
  });

  it("stays info when the gate is off (no creds, not explicitly enabled)", () => {
    const results = inspectEconomyConfig({} as BitterbotConfig);
    expect(results.some((r) => r.level === "info" && /payment gate off/i.test(r.message))).toBe(
      true,
    );
    expect(results.every((r) => r.level !== "warn")).toBe(true);
  });

  it("warns when a public A2A url has authentication none", () => {
    const cfg = {
      a2a: { url: "https://a2a.example.com", authentication: { type: "none" } },
    } as unknown as BitterbotConfig;
    const results = inspectEconomyConfig(cfg);
    expect(results.some((r) => r.level === "warn" && /authentication "none"/.test(r.message))).toBe(
      true,
    );
  });
});
