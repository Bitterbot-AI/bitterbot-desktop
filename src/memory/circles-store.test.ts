import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "./circles-store.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-31 C1: the circles membership store. Invariants under test:
// pinned wallets, key-epoch rotation on every membership change, default-deny
// scope authorization, and the domain-agnostic `kind`.

const NOW = 1_800_000_000_000;
const ALICE = "alice-pubkey";
const BOB = "bob-pubkey";
const CAROL = "carol-pubkey";
const A_WALLET = "0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1";
const B_WALLET = "0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2";

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

describe("CirclesStore", () => {
  let db: DatabaseSync;
  let store: CirclesStore;
  let circleId: string;

  beforeEach(() => {
    db = openDb();
    store = new CirclesStore(db);
    circleId = store.createCircle({
      name: "Tahoe Crew",
      creatorPubkey: ALICE,
      creatorWallet: A_WALLET,
      now: NOW,
    });
  });

  it("creates a circle with the creator as first member", () => {
    const circle = store.getCircle(circleId);
    expect(circle).toMatchObject({ name: "Tahoe Crew", kind: "expense", creatorPubkey: ALICE });
    const members = store.getMembers(circleId);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      memberPubkey: ALICE,
      role: "creator",
      pinnedWallet: A_WALLET,
    });
    expect(members[0].scopes).toEqual(DEFAULT_MEMBER_SCOPES);
  });

  it("pins the payout wallet at add time and exposes it for settlement checks", () => {
    store.addMember({ circleId, memberPubkey: BOB, pinnedWallet: B_WALLET, now: NOW + 1 });
    expect(store.pinnedWalletFor(circleId, BOB)).toBe(B_WALLET);
    expect(store.pinnedWalletFor(circleId, "stranger")).toBeNull();
  });

  it("bumps key_epoch when a member JOINS (channel key rotation signal)", () => {
    expect(store.getCircle(circleId)!.keyEpoch).toBe(0);
    store.addMember({ circleId, memberPubkey: BOB, pinnedWallet: B_WALLET, now: NOW + 1 });
    expect(store.getCircle(circleId)!.keyEpoch).toBe(1);
    store.addMember({ circleId, memberPubkey: CAROL, now: NOW + 2 });
    expect(store.getCircle(circleId)!.keyEpoch).toBe(2);
    // §5.5 review F2/F3: removal does NOT bump — the epoch only blinds the
    // gossip topic name (which an evictee already knows), so a bump grants no
    // read-exclusion and bumping on one node desyncs the remaining members.
    store.removeMember(circleId, CAROL, NOW + 3);
    expect(store.getCircle(circleId)!.keyEpoch).toBe(2);
  });

  it("re-pairing updates the pinned wallet (the explicit, epoch-bumping path)", () => {
    store.addMember({ circleId, memberPubkey: BOB, pinnedWallet: B_WALLET, now: NOW + 1 });
    const newWallet = "0xC3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3";
    store.addMember({ circleId, memberPubkey: BOB, pinnedWallet: newWallet, now: NOW + 5 });
    expect(store.pinnedWalletFor(circleId, BOB)).toBe(newWallet);
    expect(store.getMembers(circleId)).toHaveLength(2); // still one Bob
    expect(store.getCircle(circleId)!.keyEpoch).toBe(2); // both adds bumped
  });

  it("authorizes scopes default-deny", () => {
    store.addMember({
      circleId,
      memberPubkey: BOB,
      pinnedWallet: B_WALLET,
      scopes: ["ledger.read", "briefing.read"],
      now: NOW + 1,
    });
    expect(store.memberHasScope(circleId, BOB, "ledger.read")).toBe(true);
    expect(store.memberHasScope(circleId, BOB, "settle.propose")).toBe(false); // not granted
    expect(store.memberHasScope(circleId, "stranger", "ledger.read")).toBe(false); // not a member
  });

  it("suspended and left members lose all scope and drop from active lists", () => {
    store.addMember({ circleId, memberPubkey: BOB, pinnedWallet: B_WALLET, now: NOW + 1 });
    store.suspendMember(circleId, BOB, NOW + 2);
    expect(store.memberHasScope(circleId, BOB, "ledger.read")).toBe(false);
    expect(store.getMembers(circleId).map((m) => m.memberPubkey)).not.toContain(BOB);

    store.addMember({ circleId, memberPubkey: CAROL, now: NOW + 3 });
    store.removeMember(circleId, CAROL, NOW + 4);
    expect(store.memberHasScope(circleId, CAROL, "ledger.read")).toBe(false);
  });

  it("stores, replaces, and clears node-local petnames keyed by pubkey (§5.6)", () => {
    store.setPetname(BOB, "Bob from class", NOW);
    expect(store.getPetnames().get(BOB)).toBe("Bob from class");
    // Replace.
    store.setPetname(BOB, "Roommate Bob", NOW + 1);
    expect(store.getPetnames().get(BOB)).toBe("Roommate Bob");
    // Blank clears.
    store.setPetname(BOB, "   ", NOW + 2);
    expect(store.getPetnames().has(BOB)).toBe(false);
    // Explicit clear is idempotent.
    store.setPetname(CAROL, "C", NOW + 3);
    store.clearPetname(CAROL);
    store.clearPetname(CAROL);
    expect(store.getPetnames().has(CAROL)).toBe(false);
    // Capped at 80 chars.
    store.setPetname(BOB, "x".repeat(200), NOW + 4);
    expect(store.getPetnames().get(BOB)?.length).toBe(80);
  });

  it("archives, unarchives, and deletes circles (node-local)", () => {
    store.addMember({ circleId, memberPubkey: BOB, now: NOW + 1 });
    // Active circle is in both the work set and the UI set.
    expect(store.getCirclesForMember(ALICE).some((c) => c.circleId === circleId)).toBe(true);
    expect(store.getCirclesForMemberUi(ALICE).some((c) => c.circleId === circleId)).toBe(true);

    // Archive: drops from the work set, stays in the UI set (restorable).
    expect(store.archiveCircle(circleId)).toBe(true);
    expect(store.getCirclesForMember(ALICE).some((c) => c.circleId === circleId)).toBe(false);
    expect(store.getCirclesForMemberUi(ALICE).find((c) => c.circleId === circleId)?.status).toBe(
      "archived",
    );
    expect(store.archiveCircle(circleId)).toBe(false); // already archived

    // Unarchive restores it to active.
    expect(store.unarchiveCircle(circleId)).toBe(true);
    expect(store.getCircle(circleId)?.status).toBe("active");

    // Seed valid rows in several scoped tables + another circle, so the cascade
    // is actually proven (and proven scoped to ONE circle).
    const rawDb = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const seedMsg = (cid: string) =>
      rawDb
        .prepare(
          `INSERT INTO circle_messages (message_id, circle_id, author_pubkey, direction, content, created_at)
           VALUES (?, ?, 'x', 'in', 'hi', ?)`,
        )
        .run(crypto.randomUUID(), cid, NOW);
    seedMsg(circleId);
    rawDb
      .prepare(`INSERT INTO circle_read_state (circle_id, last_read_at) VALUES (?, ?)`)
      .run(circleId, NOW);
    const other = store.createCircle({ name: "Other", creatorPubkey: ALICE });
    seedMsg(other); // a row in a DIFFERENT circle

    store.deleteCircle(circleId);
    expect(store.getCircle(circleId)).toBeNull();
    expect(store.getMembers(circleId)).toHaveLength(0);
    expect(store.getCirclesForMemberUi(ALICE).some((c) => c.circleId === circleId)).toBe(false);
    const count = (t: string, cid: string) =>
      (
        rawDb.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE circle_id = ?`).get(cid) as {
          n: number;
        }
      ).n;
    expect(count("circle_messages", circleId)).toBe(0);
    expect(count("circle_read_state", circleId)).toBe(0);
    expect(count("circle_members", circleId)).toBe(0);
    // The other circle's data survived — delete is scoped to one circle.
    expect(count("circle_messages", other)).toBe(1);
  });

  it("lists circles for a member across kinds (domain-agnostic)", () => {
    const careId = store.createCircle({
      name: "Mom's Care",
      kind: "care",
      creatorPubkey: ALICE,
      now: NOW + 10,
    });
    store.addMember({ circleId, memberPubkey: BOB, now: NOW + 11 });
    const aliceCircles = store.getCirclesForMember(ALICE);
    expect(aliceCircles.map((c) => c.kind).toSorted()).toEqual(["care", "expense"]);
    const bobCircles = store.getCirclesForMember(BOB);
    expect(bobCircles.map((c) => c.circleId)).toEqual([circleId]);
    expect(careId).not.toBe(circleId);
  });
});
