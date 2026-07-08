import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../commerce/sku.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  BRIEFING_WINDOW_MS,
  compileBriefing,
  compileBriefingIfDue,
  latestBriefing,
} from "./briefing.js";
import { makeCircleEnvelope } from "./envelope.js";
import { buildChainedEventBody } from "./tab.js";

// PLAN-31 C3: the weekly briefing. Laws under test: counts/states only
// (never quoted foreign prose — the memory-laundering rule), digest-batching
// marks the window read, weekly cadence gate, capped length.

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

describe("the weekly briefing", () => {
  let db: DatabaseSync;
  let store: CirclesStore;
  let circleId: string;
  let ana: KeyPair; // self
  let bob: KeyPair; // friend

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    store = new CirclesStore(db);
    ana = generateKeyPair();
    bob = generateKeyPair();
    circleId = store.createCircle({
      name: "Tahoe Crew",
      kind: "expense",
      creatorPubkey: pubkeyId(ana),
      now: NOW,
    });
    store.addMember({
      circleId,
      memberPubkey: pubkeyId(bob),
      displayName: "Bob",
      scopes: DEFAULT_MEMBER_SCOPES,
      now: NOW,
    });
  });

  function seedWeek(): void {
    // Bob's agent sent a message with a memorable phrase we must NOT quote.
    const msg = makeCircleEnvelope(
      "message",
      circleId,
      { text: "SECRET-PHRASE-NEVER-QUOTED in the digest" },
      bob,
      NOW_S,
    );
    expect(handleCircleMethod("circle/message", { envelope: msg }, db, NOW).ok).toBe(true);
    // We replied (reciprocity).
    db.prepare(
      `INSERT INTO circle_messages
         (message_id, circle_id, author_pubkey, direction, kind, content, created_at)
       VALUES ('out1', ?, ?, 'out', 'message', 'sure thing', ?)`,
    ).run(circleId, pubkeyId(ana), NOW);
    // Bob logged an expense on the tab.
    const body = buildChainedEventBody(db, {
      circleId,
      authorPubkey: pubkeyId(bob),
      input: {
        type: "expense.add",
        memo: "pizza",
        amountCents: 4200,
        participants: [pubkeyId(ana), pubkeyId(bob)],
      },
      now: NOW,
    });
    const ev = makeCircleEnvelope(
      "event",
      circleId,
      body as unknown as Record<string, JsonValue>,
      bob,
      NOW_S,
    );
    expect(handleCircleMethod("circle/event.append", { envelope: ev }, db, NOW).ok).toBe(true);
  }

  it("reports reciprocity, presence, conversation counts, and the tab — never quoted prose", () => {
    seedWeek();
    const briefing = compileBriefing(db, { selfPubkey: pubkeyId(ana), now: NOW + 1000 });
    expect(briefing.content).toContain("1 reciprocated agent conversation");
    expect(briefing.content).toContain("Tahoe Crew");
    expect(briefing.content).toContain("2 message(s)");
    expect(briefing.content).toContain("1 expense(s), $42.00 total");
    expect(briefing.content).toContain("$21.00 behind Bob");
    // The memory-laundering rule: foreign prose is never re-rendered.
    expect(briefing.content).not.toContain("SECRET-PHRASE");
  });

  it("marks the window's messages digested (digest-batching)", () => {
    seedWeek();
    compileBriefing(db, { selfPubkey: pubkeyId(ana), now: NOW + 1000 });
    const undigested = db
      .prepare(`SELECT COUNT(*) AS n FROM circle_messages WHERE digested_at IS NULL`)
      .get() as { n: number };
    expect(undigested.n).toBe(0);
  });

  it("compiles on the weekly cadence, not more (the BeReal rule)", () => {
    seedWeek();
    const first = compileBriefingIfDue(db, { selfPubkey: pubkeyId(ana), now: NOW });
    expect(first).not.toBeNull();
    // A day later: not due.
    expect(
      compileBriefingIfDue(db, { selfPubkey: pubkeyId(ana), now: NOW + 86_400_000 }),
    ).toBeNull();
    // A week later: due.
    const next = compileBriefingIfDue(db, {
      selfPubkey: pubkeyId(ana),
      now: NOW + BRIEFING_WINDOW_MS + 1,
    });
    expect(next).not.toBeNull();
    expect(latestBriefing(db)?.briefingId).toBe(next?.briefingId);
  });

  it("celebrates equilibrium when the tab is square", () => {
    // Two identical opposing expenses -> all square.
    const A = pubkeyId(ana);
    const B = pubkeyId(bob);
    for (const [key, memo] of [
      [ana, "groceries"],
      [bob, "gas"],
    ] as Array<[KeyPair, string]>) {
      const body = buildChainedEventBody(db, {
        circleId,
        authorPubkey: pubkeyId(key),
        input: { type: "expense.add", memo, amountCents: 2000, participants: [A, B] },
        now: NOW,
      });
      const ev = makeCircleEnvelope(
        "event",
        circleId,
        body as unknown as Record<string, JsonValue>,
        key,
        NOW_S,
      );
      expect(handleCircleMethod("circle/event.append", { envelope: ev }, db, NOW).ok).toBe(true);
    }
    const briefing = compileBriefing(db, { selfPubkey: pubkeyId(ana), now: NOW + 1000 });
    expect(briefing.content).toContain("All square");
  });
});
