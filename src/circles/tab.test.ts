import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../commerce/sku.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { makeCircleEnvelope } from "./envelope.js";
import { buildChainedEventBody, computeTabBalances, splitAmount } from "./tab.js";

// PLAN-31 C2 (v3): the shared tab. Under test: deterministic largest-
// remainder splits with hash tie-breaks, the union fold (net + pairwise),
// author-only reversals, mutual-debt display collapse, and chain building.
// NO settlement exists anywhere in this file by design.

const NOW = 1_800_000_000_000;
const NOW_S = Math.floor(NOW / 1000);

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

describe("splitAmount", () => {
  it("splits evenly when divisible", () => {
    const shares = splitAmount("ev1", 3000, ["a", "b", "c"]);
    expect([...shares.values()]).toEqual([1000, 1000, 1000]);
  });

  it("distributes remainders deterministically and exactly", () => {
    const shares1 = splitAmount("ev1", 1000, ["a", "b", "c"]);
    const shares2 = splitAmount("ev1", 1000, ["c", "a", "b"]); // order-independent
    const byKey = (a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]);
    expect([...shares1.entries()].toSorted(byKey)).toEqual([...shares2.entries()].toSorted(byKey));
    const total = [...shares1.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(1000);
    // A different event id may tie-break differently, but always sums exactly.
    const other = splitAmount("ev2", 1000, ["a", "b", "c"]);
    expect([...other.values()].reduce((s, v) => s + v, 0)).toBe(1000);
  });
});

describe("the tab fold (two-member circle over real handlers)", () => {
  let db: DatabaseSync;
  let store: CirclesStore;
  let circleId: string;
  let ana: KeyPair;
  let bob: KeyPair;

  function append(key: KeyPair, input: Parameters<typeof buildChainedEventBody>[1]["input"]) {
    const body = buildChainedEventBody(db, {
      circleId,
      authorPubkey: pubkeyId(key),
      input,
      now: NOW,
    });
    const envelope = makeCircleEnvelope(
      "event",
      circleId,
      body as unknown as Record<string, JsonValue>,
      key,
      NOW_S,
    );
    return handleCircleMethod("circle/event.append", { envelope }, db, NOW);
  }

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    store = new CirclesStore(db);
    ana = generateKeyPair();
    bob = generateKeyPair();
    circleId = store.createCircle({
      name: "Roomies",
      kind: "expense",
      creatorPubkey: pubkeyId(ana),
      now: NOW,
    });
    store.addMember({
      circleId,
      memberPubkey: pubkeyId(bob),
      scopes: DEFAULT_MEMBER_SCOPES,
      now: NOW,
    });
  });

  it("folds expenses into net + pairwise balances", () => {
    const A = pubkeyId(ana);
    const B = pubkeyId(bob);
    // Ana pays $42.00 split between both; Bob pays $10.00 split between both.
    expect(
      append(ana, { type: "expense.add", memo: "pizza", amountCents: 4200, participants: [A, B] })
        .ok,
    ).toBe(true);
    expect(
      append(bob, { type: "expense.add", memo: "coffee", amountCents: 1000, participants: [A, B] })
        .ok,
    ).toBe(true);
    const balances = computeTabBalances(db, circleId);
    expect(balances.expenses).toBe(2);
    expect(balances.totalCents).toBe(5200);
    // Bob owes Ana 2100, Ana owes Bob 500 -> collapsed: Bob owes Ana 1600.
    expect(balances.pairwise[B]?.[A]).toBe(1600);
    expect(balances.pairwise[A]?.[B]).toBeUndefined();
    expect(balances.net[A]).toBe(1600);
    expect(balances.net[B]).toBe(-1600);
    // The fold is zero-sum.
    expect(Object.values(balances.net).reduce((s, v) => s + v, 0)).toBe(0);
  });

  it("author reversals cancel an expense; foreign reversals do not", () => {
    const A = pubkeyId(ana);
    const B = pubkeyId(bob);
    const first = append(ana, {
      type: "expense.add",
      memo: "oops double-charged",
      amountCents: 4200,
      participants: [A, B],
    });
    if (!first.ok) throw new Error("append failed");
    const eventId = (first.result as { eventId: string }).eventId;

    // Bob cannot erase Ana's expense.
    expect(append(bob, { type: "expense.reversal", reverses: eventId }).ok).toBe(true);
    expect(computeTabBalances(db, circleId).expenses).toBe(1);

    // Ana reverses her own: the expense drops out of the fold.
    expect(append(ana, { type: "expense.reversal", reverses: eventId }).ok).toBe(true);
    const after = computeTabBalances(db, circleId);
    expect(after.expenses).toBe(0);
    expect(after.reversed).toBe(1);
    expect(after.pairwise).toEqual({});
  });

  it("keeps exact cents with odd splits (largest remainder end-to-end)", () => {
    const A = pubkeyId(ana);
    const B = pubkeyId(bob);
    expect(
      append(ana, {
        type: "expense.add",
        memo: "odd split",
        amountCents: 1001,
        participants: [A, B],
      }).ok,
    ).toBe(true);
    const balances = computeTabBalances(db, circleId);
    // Bob's share is 500 or 501, never a lost or invented cent.
    const owed = balances.pairwise[B]?.[A] ?? 0;
    expect([500, 501]).toContain(owed);
    expect(balances.net[A]).toBe(owed);
    expect(balances.net[B]).toBe(-owed);
  });

  it("builds correct chain bodies (seq, prev_hash, heads)", () => {
    const A = pubkeyId(ana);
    const first = buildChainedEventBody(db, {
      circleId,
      authorPubkey: A,
      input: { type: "note.add", memo: "hello" },
      now: NOW,
    });
    expect(first.seq).toBe(0);
    expect(first.prev_hash).toBeNull();
    const env = makeCircleEnvelope(
      "event",
      circleId,
      first as unknown as Record<string, JsonValue>,
      ana,
      NOW_S,
    );
    expect(handleCircleMethod("circle/event.append", { envelope: env }, db, NOW).ok).toBe(true);
    const second = buildChainedEventBody(db, {
      circleId,
      authorPubkey: A,
      input: { type: "note.add", memo: "again" },
      now: NOW,
    });
    expect(second.seq).toBe(1);
    expect(typeof second.prev_hash).toBe("string");
    expect(second.heads[A]).toBe(0);
  });

  it("rejects invalid expense inputs before anything is signed", () => {
    expect(() =>
      buildChainedEventBody(db, {
        circleId,
        authorPubkey: pubkeyId(ana),
        input: { type: "expense.add", memo: "bad", amountCents: 12.5, participants: ["x"] },
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      buildChainedEventBody(db, {
        circleId,
        authorPubkey: pubkeyId(ana),
        input: { type: "expense.add", memo: "bad", amountCents: 100, participants: [] },
      }),
    ).toThrow(/participants/);
  });
});
