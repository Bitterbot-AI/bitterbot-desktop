import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  PRACTICE_KIND,
  PRACTICE_PARTNER_NAME,
  ensurePracticeCircle,
  practiceReply,
  realConnectionCount,
} from "./practice.js";

// PLAN-31 §4.3: the labeled practice partner. Laws under test: always a
// bot by name, replies ride the real inbound path (wrapped), never counts
// as a connection, retires the moment a real connection exists.

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

describe("practice partner", () => {
  let db: DatabaseSync;
  let self: KeyPair;
  let partner: KeyPair;

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    self = generateKeyPair();
    partner = generateKeyPair();
  });

  it("creates a labeled practice circle for a lonely node and opens the script", async () => {
    const circleId = ensurePracticeCircle(db, {
      selfPubkey: pubkeyId(self),
      partnerKey: partner,
      now: NOW,
    });
    expect(circleId).toBeTruthy();
    const store = new CirclesStore(db);
    const members = store.getMembers(circleId as string);
    expect(members.some((m) => m.displayName === PRACTICE_PARTNER_NAME)).toBe(true);

    // The bot opens proactively; its message arrives wrapped like any agent's.
    expect(await practiceReply(db, { selfPubkey: pubkeyId(self), partnerKey: partner })).toBe(true);
    const row = db.prepare(`SELECT content FROM circle_messages WHERE direction = 'in'`).get() as {
      content: string;
    };
    expect(row.content).toContain("Practice Partner");
    expect(row.content.toLowerCase()).toContain("untrusted");

    // It does not double-speak while the human is silent.
    expect(await practiceReply(db, { selfPubkey: pubkeyId(self), partnerKey: partner })).toBe(
      false,
    );
  });

  it("never counts toward the friend-node count", () => {
    ensurePracticeCircle(db, { selfPubkey: pubkeyId(self), partnerKey: partner, now: NOW });
    expect(realConnectionCount(db, pubkeyId(self))).toBe(0);
  });

  it("retires when a real connection exists", () => {
    const circleId = ensurePracticeCircle(db, {
      selfPubkey: pubkeyId(self),
      partnerKey: partner,
      now: NOW,
    }) as string;

    // A real friend connects (a non-practice circle with both members).
    const store = new CirclesStore(db);
    const real = store.createCircle({
      name: "Ana & Friend",
      kind: "connection",
      creatorPubkey: pubkeyId(self),
      now: NOW,
    });
    store.addMember({
      circleId: real,
      memberPubkey: "ed25519:" + "a".repeat(64),
      scopes: DEFAULT_MEMBER_SCOPES,
      now: NOW,
    });
    expect(realConnectionCount(db, pubkeyId(self))).toBe(1);

    // The next upkeep retires the practice circle.
    const after = ensurePracticeCircle(db, {
      selfPubkey: pubkeyId(self),
      partnerKey: partner,
      now: NOW + 1,
    });
    expect(after).toBeNull();
    expect(store.getCircle(circleId)?.status).toBe("archived");
    // And it stays retired (no resurrection).
    expect(
      ensurePracticeCircle(db, { selfPubkey: pubkeyId(self), partnerKey: partner, now: NOW + 2 }),
    ).toBeNull();
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM circles WHERE kind = ?`)
      .get(PRACTICE_KIND) as { n: number };
    expect(count.n).toBe(1);
  });
});
