import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../commerce/sku.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { makeCircleEnvelope } from "./envelope.js";
import { buildChainedEventBody } from "./tab.js";

// Message deletion rides the signed event chain (`message.delete`), so it
// replicates over dial/mailbox/gossip/sync like reactions do. The invariant
// under test: ONLY the message's own author can tombstone it — a peer signing
// a delete for someone else's words is stored (chain integrity) but inert.

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

describe("circle message deletion", () => {
  let db: DatabaseSync;
  let store: CirclesStore;
  let circleId: string;
  let ana: KeyPair;
  let bob: KeyPair;

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    store = new CirclesStore(db);
    ana = generateKeyPair();
    bob = generateKeyPair();
    circleId = store.createCircle({
      name: "Tahoe Crew",
      kind: "connection",
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

  function inboundMessage(author: KeyPair, text: string): string {
    const env = makeCircleEnvelope("message", circleId, { text }, author, NOW_S);
    const out = handleCircleMethod("circle/message", { envelope: env }, db, NOW);
    expect(out.ok).toBe(true);
    return env.id;
  }

  function buildDeleteEnvelope(author: KeyPair, targetEnvelopeId: string) {
    const body = buildChainedEventBody(db, {
      circleId,
      authorPubkey: pubkeyId(author),
      input: { type: "message.delete", targetEnvelopeId, updatedAt: NOW },
      now: NOW,
    });
    return makeCircleEnvelope(
      "event",
      circleId,
      body as unknown as Record<string, JsonValue>,
      author,
      NOW_S,
    );
  }

  function appendDelete(author: KeyPair, targetEnvelopeId: string) {
    const env = buildDeleteEnvelope(author, targetEnvelopeId);
    return handleCircleMethod("circle/event.append", { envelope: env }, db, NOW);
  }

  function messageRow(envelopeId: string): {
    content: string;
    deleted_at: number | null;
    deleted_by: string | null;
  } {
    return db
      .prepare(`SELECT content, deleted_at, deleted_by FROM circle_messages WHERE envelope_id = ?`)
      .get(envelopeId) as { content: string; deleted_at: number | null; deleted_by: string | null };
  }

  it("tombstones a message when its own author deletes it", () => {
    const envId = inboundMessage(bob, "regrettable take");
    expect(messageRow(envId).content).toContain("regrettable take");

    const out = appendDelete(bob, envId);
    expect(out.ok).toBe(true);

    const row = messageRow(envId);
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(pubkeyId(bob));
    expect(row.content).toBe(""); // blanked at rest
  });

  it("ignores a delete signed by someone other than the message author", () => {
    const envId = inboundMessage(bob, "bob's words");

    // Ana (circle creator, full scopes) tries to delete Bob's message.
    const out = appendDelete(ana, envId);
    expect(out.ok).toBe(true); // the EVENT is valid and chained…

    const row = messageRow(envId);
    expect(row.deleted_at).toBeNull(); // …but the tombstone never applies
    expect(row.content).toContain("bob's words");
  });

  it("honors a retraction that arrives BEFORE its target message", () => {
    // Mailbox/sync ordering: B can receive A's `message.delete` event first
    // (the delete dials through while the message sits in the mailbox), and
    // replays of the delete dedupe before the tombstone hook — so the
    // message insert itself must check the chain for a prior retraction.
    const messageEnv = makeCircleEnvelope("message", circleId, { text: "premature" }, bob, NOW_S);

    const del = appendDelete(bob, messageEnv.id);
    expect(del.ok).toBe(true); // delete lands first; no message row yet

    const out = handleCircleMethod("circle/message", { envelope: messageEnv }, db, NOW);
    expect(out.ok).toBe(true);

    const row = messageRow(messageEnv.id);
    expect(row.deleted_at).not.toBeNull(); // born tombstoned
    expect(row.content).toBe("");
    expect(row.deleted_by).toBe(pubkeyId(bob));
  });

  it("keeps the row (reply anchor) and is idempotent on replay", () => {
    const envId = inboundMessage(bob, "soon gone");
    const deleteEnv = buildDeleteEnvelope(bob, envId);
    const first = handleCircleMethod("circle/event.append", { envelope: deleteEnv }, db, NOW);
    expect(first.ok).toBe(true);
    const afterFirst = messageRow(envId);

    // Sync replay of the SAME chained event (identical envelope) must dedupe.
    const replay = handleCircleMethod("circle/event.append", { envelope: deleteEnv }, db, NOW);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.result as { duplicate?: boolean }).duplicate).toBe(true);
    }
    const afterReplay = messageRow(envId);
    expect(afterReplay).toEqual(afterFirst);
    expect(afterReplay.deleted_at).toBe(afterFirst.deleted_at);

    // The row itself survives for reply threading.
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM circle_messages WHERE envelope_id = ?`)
      .get(envId) as { n: number };
    expect(count.n).toBe(1);
  });
});
