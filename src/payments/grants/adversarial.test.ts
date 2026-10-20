/**
 * PLAN-48 Phase 6 — consolidated adversarial pass on the spend-grant + escalation
 * surface. Where the per-increment build tests assert the happy path and its
 * direct guards, this suite attacks the surface as a whole along the vectors the
 * plan names: grant forgery/replay, escalation bypass, one-time-grant reuse
 * (incl. concurrency and failed usage-record), revocation races, default-cap
 * escape, and approval-flow integrity.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { VerifyEd25519Fn } from "../ap2/consent.js";
import { SpendGrantStore } from "./spend-grant-store.js";
import {
  buildSpendGrant,
  grantSigningMaterial,
  SPEND_GRANT_DOMAIN,
  usdc,
  verifySpendGrant,
  type SpendGrant,
} from "./spend-grant.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OWNER = "ed25519:" + "ab".repeat(32);
const ATTACKER = "ed25519:" + "cd".repeat(32);
const SELLER = "0x00000000000000000000000000000000000000aa";
const DAY = 86_400;

const signAs = (pk: string) => (msg: string) => `${pk}:${sha(msg)}`;
const signOwner = signAs(OWNER);
const verifyEd25519: VerifyEd25519Fn = (msg, sig, pk) => sig === `${pk}:${sha(msg)}`;
const signer = { ownerPubkey: OWNER, signOwner, verifyEd25519 };

function store() {
  return new SpendGrantStore(new DatabaseSync(":memory:"));
}
function standingGrant(over?: { allowance?: number; payees?: string[] }): SpendGrant {
  return buildSpendGrant({
    ownerPubkey: OWNER,
    scope: { allowed_payees: over?.payees ?? [SELLER] },
    allowance: usdc(over?.allowance ?? 5),
    periodSeconds: DAY,
    ttlMs: 30 * DAY * 1000,
    signOwner,
  });
}

describe("PLAN-48 Phase 6 — grant + escalation adversarial pass", () => {
  // ── Grant forgery / replay ──
  it("rejects a grant re-signed by a non-owner key (forgery)", () => {
    // Attacker mints a fat grant and signs it with THEIR key, but claims OWNER.
    const forged = buildSpendGrant({
      ownerPubkey: OWNER, // claims to be the owner...
      scope: { allowed_payees: ["*"] },
      allowance: usdc(1_000_000),
      periodSeconds: DAY,
      ttlMs: DAY * 1000,
      signOwner: signAs(ATTACKER), // ...but signs with the attacker key
    });
    expect(verifySpendGrant(forged, verifyEd25519).ok).toBe(false);
    const s = store();
    expect(() => s.setGrant(forged, verifyEd25519)).toThrow(/invalid grant/);
  });

  it("rejects a grant whose owner_pubkey was swapped to the attacker's after signing", () => {
    const g = standingGrant();
    g.claims.owner_pubkey = ATTACKER; // repoint ownership
    // grant_id no longer matches the mutated claims, and the sig is over the old owner.
    expect(verifySpendGrant(g, verifyEd25519).ok).toBe(false);
  });

  it("domain-separates the grant signature (cannot be a mandate/consent/x402 signature)", () => {
    const g = standingGrant();
    expect(grantSigningMaterial(g.claims).startsWith(SPEND_GRANT_DOMAIN)).toBe(true);
    // The signed bytes carry the grant domain tag, so the same signature bytes
    // cannot verify against material lacking that tag (a different protocol).
    const withoutDomain = grantSigningMaterial(g.claims).slice(SPEND_GRANT_DOMAIN.length);
    expect(verifyEd25519(withoutDomain, g.signature, g.claims.owner_pubkey)).toBe(false);
  });

  // ── One-time (approval) grant reuse ──
  it("one-time grant: single-use claim admits exactly one caller (concurrency)", () => {
    const s = store();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    const g = s.approve(a.approvalId, signer);
    // Two racing claims of the same one-time grant: only the first wins.
    expect(s.claimSingleUse(g.claims.grant_id)).toBe(true);
    expect(s.claimSingleUse(g.claims.grant_id)).toBe(false);
  });

  it("one-time grant: once used it no longer resolves as covering (even with period room)", () => {
    const s = store();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    const g = s.approve(a.approvalId, signer);
    // Before use it covers; usage was NOT recorded (simulating a failed
    // recordUsage), yet after the single-use claim it must not resolve again.
    expect(
      s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 }).grant?.claims.grant_id,
    ).toBe(g.claims.grant_id);
    expect(s.claimSingleUse(g.claims.grant_id)).toBe(true);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 }).grant).toBeNull();
  });

  // ── Revocation race ──
  it("a revoked grant authorizes no new spend on the next resolution", () => {
    const s = store();
    s.setGrant(standingGrant(), verifyEd25519);
    const before = s.activeGrantFor({ payee: SELLER, amountUsd: 1, verifyEd25519 });
    expect(before.grant).not.toBeNull();
    s.revokeGrant(before.grant!.claims.grant_id);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 1, verifyEd25519 }).grant).toBeNull();
  });

  // ── Default-cap escape / period accounting ──
  it("period allowance cannot be overspent across sequential recorded spends", () => {
    const s = store();
    const g = standingGrant({ allowance: 1 });
    s.setGrant(g, verifyEd25519);
    // Spend $0.60, record it; a second $0.60 must not be covered (0.6+0.6 > 1).
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.6, verifyEd25519 }).grant).not.toBeNull();
    s.recordUsage(g.claims.grant_id, 0.6);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.6, verifyEd25519 }).grant).toBeNull();
  });

  it("a grant for payee A never covers a spend to payee B", () => {
    const s = store();
    s.setGrant(standingGrant({ payees: [SELLER] }), verifyEd25519);
    const B = "0x00000000000000000000000000000000000000bb";
    expect(s.activeGrantFor({ payee: B, amountUsd: 0.1, verifyEd25519 }).grant).toBeNull();
  });

  // ── Approval-flow integrity ──
  it("cannot mint a grant by approving an unknown or already-resolved approval", () => {
    const s = store();
    expect(() => s.approve("approval-does-not-exist", signer)).toThrow(/not found/);
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    s.deny(a.approvalId);
    expect(() => s.approve(a.approvalId, signer)).toThrow(/already denied/);
  });

  it("a directly-tampered stored grant row is rejected on read (verify-on-read)", () => {
    const db = new DatabaseSync(":memory:");
    const s = new SpendGrantStore(db);
    const g = standingGrant({ allowance: 1 });
    s.setGrant(g, verifyEd25519);
    const inflated = JSON.stringify({ ...g.claims, allowance: usdc(999) });
    db.prepare(`UPDATE spend_grants SET claims_json = ? WHERE grant_id = ?`).run(
      inflated,
      g.claims.grant_id,
    );
    // computeGrantId over the mutated claims no longer matches -> not covering.
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 500, verifyEd25519 }).grant).toBeNull();
  });
});
