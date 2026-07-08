import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../commerce/envelope.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { createInvite, parseInviteCode, redeemInvite, revokeInvite } from "./invites.js";

// PLAN-31 C1: invite create/parse/redeem. Invariants: secret never at rest
// (hash only), signature verified before any dial, expiry + single-use +
// rejoin-without-consuming, revocation.

const NOW = 1_800_000_000_000;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

describe("circle invites", () => {
  let db: DatabaseSync;
  const inviter = generateKeyPair();

  const baseArgs = {
    circleId: "circle-1",
    circleName: "Tahoe Crew",
    circleKind: "connection",
    inviterKey: inviter,
    inviterName: "Ana",
    inviterA2aUrl: "https://ana.example.com",
    scopes: ["roster.read", "message.send"],
    now: NOW,
  };

  beforeEach(() => {
    db = openDb();
  });

  it("stores only the secret's hash at rest", () => {
    const created = createInvite(db, baseArgs);
    const row = db
      .prepare(`SELECT token_hash FROM circle_invites WHERE invite_id = ?`)
      .get(created.inviteId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.code).not.toContain(row.token_hash);
  });

  it("round-trips create -> parse with verified authorship", () => {
    const created = createInvite(db, baseArgs);
    const parsed = parseInviteCode(created.code, NOW + 1000);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.invite.inviteId).toBe(created.inviteId);
    expect(parsed.invite.circleId).toBe("circle-1");
    expect(parsed.invite.inviterPubkey).toBe(pubkeyId(inviter));
    expect(parsed.invite.inviterA2aUrl).toBe("https://ana.example.com");
    expect(parsed.invite.scopes).toEqual(["roster.read", "message.send"]);
  });

  it("rejects tampered codes (any byte flip breaks the signature or shape)", () => {
    const created = createInvite(db, baseArgs);
    const [prefix, payload] = created.code.split(".") as [string, string];
    const flipped = payload.slice(0, 30) + (payload[30] === "A" ? "B" : "A") + payload.slice(31);
    const parsed = parseInviteCode(`${prefix}.${flipped}`, NOW + 1000);
    expect(parsed.ok).toBe(false);
  });

  it("rejects expired invites at parse time", () => {
    const created = createInvite(db, { ...baseArgs, ttlMs: 1000 });
    expect(parseInviteCode(created.code, NOW + 2000).ok).toBe(false);
  });

  it("redeems once, then exhausts; wrong secret never redeems", () => {
    const created = createInvite(db, baseArgs);
    const parsed = parseInviteCode(created.code, NOW + 1000);
    if (!parsed.ok) throw new Error("parse failed");

    const bad = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: "not-the-secret-not-the-secret-xx",
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: false,
      now: NOW + 1000,
    });
    expect(bad.ok).toBe(false);

    const good = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: parsed.invite.secret,
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: false,
      now: NOW + 1000,
    });
    expect(good.ok).toBe(true);

    const second = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: parsed.invite.secret,
      presenterPubkey: "ed25519:carol",
      presenterIsActiveMember: false,
      now: NOW + 2000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/exhausted/);
  });

  it("lets an active member re-run the ceremony without consuming a use", () => {
    const created = createInvite(db, baseArgs);
    const parsed = parseInviteCode(created.code, NOW + 1000);
    if (!parsed.ok) throw new Error("parse failed");
    const rejoin = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: parsed.invite.secret,
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: true,
      now: NOW + 1000,
    });
    expect(rejoin.ok).toBe(true);
    if (rejoin.ok) expect(rejoin.rejoin).toBe(true);
    const fresh = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: parsed.invite.secret,
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: false,
      now: NOW + 1500,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.rejoin).toBe(false);
  });

  it("refuses revoked and expired invites at redeem time", () => {
    const created = createInvite(db, baseArgs);
    const parsed = parseInviteCode(created.code, NOW + 1000);
    if (!parsed.ok) throw new Error("parse failed");
    revokeInvite(db, created.inviteId);
    const revoked = redeemInvite(db, {
      inviteId: created.inviteId,
      secret: parsed.invite.secret,
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: false,
      now: NOW + 1000,
    });
    expect(revoked.ok).toBe(false);

    const short = createInvite(db, { ...baseArgs, ttlMs: 1000 });
    const shortParsed = parseInviteCode(short.code, NOW + 500);
    if (!shortParsed.ok) throw new Error("parse failed");
    const late = redeemInvite(db, {
      inviteId: short.inviteId,
      secret: shortParsed.invite.secret,
      presenterPubkey: "ed25519:bob",
      presenterIsActiveMember: false,
      now: NOW + 5000,
    });
    expect(late.ok).toBe(false);
  });
});
