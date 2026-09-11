import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { VerifyEd25519Fn } from "../ap2/consent.js";
import { SpendGrantStore } from "./spend-grant-store.js";
import {
  buildSpendGrant,
  computeGrantId,
  grantCovers,
  usdc,
  verifySpendGrant,
  type SpendGrant,
} from "./spend-grant.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OWNER = "ed25519:" + "ab".repeat(32);
const SELLER = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const DAY = 86_400;

const signOwner = (msg: string) => `${OWNER}:${sha(msg)}`;
const verifyEd25519: VerifyEd25519Fn = (msg, sig, pk) => sig === `${pk}:${sha(msg)}`;

function grant(opts?: {
  payees?: string[];
  allowance?: number;
  perTx?: number;
  ttlMs?: number;
  now?: number;
}): SpendGrant {
  return buildSpendGrant({
    ownerPubkey: OWNER,
    scope: { allowed_payees: opts?.payees ?? [SELLER] },
    allowance: usdc(opts?.allowance ?? 1),
    periodSeconds: DAY,
    perTxMax: opts?.perTx !== undefined ? usdc(opts.perTx) : undefined,
    ttlMs: opts?.ttlMs ?? 30 * DAY * 1000,
    signOwner,
    now: opts?.now,
  });
}

describe("SpendGrant (PLAN-48 Phase 0) — signing + coverage", () => {
  it("builds a grant whose id and signature verify (I4)", () => {
    expect(verifySpendGrant(grant(), verifyEd25519).ok).toBe(true);
  });

  it("rejects a grant whose claims were mutated after signing (grant_id guard)", () => {
    const g = grant();
    g.claims.allowance = usdc(999);
    expect(verifySpendGrant(g, verifyEd25519).ok).toBe(false);
  });

  it("rejects a grant whose id was recomputed but signature kept (signature guard)", () => {
    const g = grant();
    g.claims.allowance = usdc(999);
    const { grant_id: _omit, ...rest } = g.claims;
    g.claims.grant_id = computeGrantId(rest); // fix id, but signature is over the old claims
    const r = verifySpendGrant(g, verifyEd25519);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature/);
  });

  it("covers an in-scope, in-budget spend and rejects out-of-scope ones", () => {
    const g = grant({ allowance: 1, perTx: 0.5 });
    const now = Math.floor(Date.now() / 1000);
    expect(grantCovers(g, { payee: SELLER, amountUsd: 0.25, consumedInPeriodUsd: 0, now }).ok).toBe(
      true,
    );
    expect(
      grantCovers(g, { payee: OTHER, amountUsd: 0.25, consumedInPeriodUsd: 0, now }).reason,
    ).toMatch(/scope/);
    expect(
      grantCovers(g, { payee: SELLER, amountUsd: 0.9, consumedInPeriodUsd: 0, now }).reason,
    ).toMatch(/per-transaction/);
    expect(
      grantCovers(g, { payee: SELLER, amountUsd: 0.5, consumedInPeriodUsd: 0.8, now }).reason,
    ).toMatch(/allowance exhausted/);
  });

  it("rejects an expired grant", () => {
    const g = grant({ ttlMs: 1000 });
    expect(
      grantCovers(g, {
        payee: SELLER,
        amountUsd: 0.1,
        consumedInPeriodUsd: 0,
        now: g.claims.exp + 5,
      }).reason,
    ).toMatch(/expired/);
  });
});

describe("SpendGrantStore (PLAN-48 Phase 0)", () => {
  function store() {
    return new SpendGrantStore(new DatabaseSync(":memory:"));
  }

  it("stores a grant and resolves it for an in-scope spend", () => {
    const s = store();
    const g = grant({ allowance: 1 });
    s.setGrant(g, verifyEd25519);
    const res = s.activeGrantFor({ payee: SELLER, amountUsd: 0.25, verifyEd25519 });
    expect(res.grant?.claims.grant_id).toBe(g.claims.grant_id);
  });

  it("consumes the period allowance across recorded usage (escalates when exhausted)", () => {
    const s = store();
    const g = grant({ allowance: 1 });
    s.setGrant(g, verifyEd25519);
    s.recordUsage(g.claims.grant_id, 0.8);
    const res = s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 });
    expect(res.grant).toBeNull();
    expect(res.reason).toMatch(/allowance exhausted/);
  });

  it("revocation takes effect immediately (I3)", () => {
    const s = store();
    const g = grant();
    s.setGrant(g, verifyEd25519);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.1, verifyEd25519 }).grant).not.toBeNull();
    s.revokeGrant(g.claims.grant_id);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.1, verifyEd25519 }).grant).toBeNull();
  });

  it("does not resolve an expired grant", () => {
    const s = store();
    const past = Date.now() - 10 * DAY * 1000;
    s.setGrant(grant({ ttlMs: 1000, now: past }), verifyEd25519);
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.1, verifyEd25519 }).grant).toBeNull();
  });

  it("prefers a payee-specific grant over a wildcard grant", () => {
    const s = store();
    s.setGrant(grant({ payees: ["*"], allowance: 1 }), verifyEd25519);
    s.setGrant(grant({ payees: [SELLER], allowance: 1 }), verifyEd25519);
    const res = s.activeGrantFor({ payee: SELLER, amountUsd: 0.1, verifyEd25519 });
    expect(res.grant?.claims.scope.allowed_payees).toEqual([SELLER]);
  });

  it("refuses to store a grant with an invalid signature", () => {
    const s = store();
    const g = grant();
    g.signature = `${OWNER}:${"0".repeat(64)}`;
    expect(() => s.setGrant(g, verifyEd25519)).toThrow(/invalid grant/);
  });

  it("skips a grant whose stored row was tampered with (verify-on-read)", () => {
    const db = new DatabaseSync(":memory:");
    const s = new SpendGrantStore(db);
    const g = grant({ allowance: 1 });
    s.setGrant(g, verifyEd25519);
    // Tamper the persisted claims directly, bypassing setGrant's verification.
    const tampered = JSON.stringify({ ...g.claims, allowance: usdc(999) });
    db.prepare(`UPDATE spend_grants SET claims_json = ? WHERE grant_id = ?`).run(
      tampered,
      g.claims.grant_id,
    );
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 500, verifyEd25519 }).grant).toBeNull();
  });
});

describe("SpendGrantStore — escalation approval loop (PLAN-48 Phase 2)", () => {
  const signer = { ownerPubkey: OWNER, signOwner, verifyEd25519 };
  function store() {
    return new SpendGrantStore(new DatabaseSync(":memory:"));
  }

  it("raises a pending approval and dedupes duplicate requests", () => {
    const s = store();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5, reason: "new merchant" });
    expect(a.status).toBe("pending");
    const b = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    expect(b.approvalId).toBe(a.approvalId); // deduped
    expect(s.listApprovals("pending")).toHaveLength(1);
  });

  it("approving mints a one-time grant that then covers exactly that spend", () => {
    const s = store();
    // No grant yet: the spend is out of scope.
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 }).grant).toBeNull();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    const grant = s.approve(a.approvalId, signer);
    expect(verifySpendGrant(grant, verifyEd25519).ok).toBe(true);
    // Now the exact spend is covered...
    expect(
      s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 }).grant?.claims.grant_id,
    ).toBe(grant.claims.grant_id);
    // ...but a larger spend to the same payee is not (one-time, scoped to the amount).
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 1.0, verifyEd25519 }).grant).toBeNull();
    expect(s.getApproval(a.approvalId)?.status).toBe("approved");
  });

  it("denying resolves the request and mints nothing", () => {
    const s = store();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    s.deny(a.approvalId);
    expect(s.getApproval(a.approvalId)?.status).toBe("denied");
    expect(s.activeGrantFor({ payee: SELLER, amountUsd: 0.5, verifyEd25519 }).grant).toBeNull();
  });

  it("refuses to approve a non-pending request", () => {
    const s = store();
    const a = s.requestApproval({ payee: SELLER, amountUsd: 0.5 });
    s.approve(a.approvalId, signer);
    expect(() => s.approve(a.approvalId, signer)).toThrow(/already approved/);
  });
});
