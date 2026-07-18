import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { computeMessageAnnotations } from "./annotations.js";

// Phase D annotations fold under HOSTILE input: a peer signs raw bodies, so
// sender-side normalization (tab.ts) is worthless here. These pin the
// adversarial-pass fixes: forged-attribution targets dropped, author-claimed
// timestamps clamped, emoji sets re-capped, ties broken on the replicated
// event_hash.

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

let seq = 0;
function insertEvent(
  db: DatabaseSync,
  args: {
    author: string;
    type: "message.react" | "message.pin";
    body: Record<string, unknown>;
    receivedAt: number;
    eventHash?: string;
  },
): void {
  seq += 1;
  db.prepare(
    `INSERT INTO circle_events
       (event_id, circle_id, author_pubkey, seq, event_type, body_json,
        envelope_json, event_hash, claimed_at, received_at)
     VALUES (?, 'c1', ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    args.author,
    seq,
    args.type,
    JSON.stringify(args.body),
    args.eventHash ?? `hash-${seq}`,
    args.receivedAt,
    args.receivedAt,
  );
}

describe("computeMessageAnnotations (hostile input)", () => {
  let db: DatabaseSync;
  const T0 = 1_800_000_000_000;
  beforeEach(() => {
    db = openDb();
    seq = 0;
  });

  it("drops a target crafted to forge another member's attribution", () => {
    // Pre-fix, "env-1\n<victim>" hijacked the joined LWW key and rendered the
    // attacker's emojis as the victim's — and the victim could never clear it.
    insertEvent(db, {
      author: "ed25519:attacker",
      type: "message.react",
      body: {
        target_envelope_id: "env-1\ned25519:victim",
        emojis: ["💀"],
        updated_at: T0,
      },
      receivedAt: T0,
    });
    const out = computeMessageAnnotations(db, "c1");
    expect(out.reactions).toEqual({});
  });

  it("clamps a far-future updated_at so honest later writes still win", () => {
    // Grief-pin with updated_at at the max timestamp…
    insertEvent(db, {
      author: "ed25519:griefer",
      type: "message.pin",
      body: { target_envelope_id: "env-1", pinned: true, updated_at: 8_640_000_000_000_000 },
      receivedAt: T0,
    });
    expect(computeMessageAnnotations(db, "c1").pins).toEqual(["env-1"]);
    // …an honest unpin 10 minutes later out-clamps it (clamp = received + 5m).
    insertEvent(db, {
      author: "ed25519:honest",
      type: "message.pin",
      body: { target_envelope_id: "env-1", pinned: false, updated_at: T0 + 10 * 60_000 },
      receivedAt: T0 + 10 * 60_000,
    });
    expect(computeMessageAnnotations(db, "c1").pins).toEqual([]);
  });

  it("re-caps an oversized emoji payload on the fold side", () => {
    insertEvent(db, {
      author: "ed25519:spammer",
      type: "message.react",
      body: {
        target_envelope_id: "env-1",
        emojis: Array.from({ length: 50 }, (_, i) => `${"x".repeat(200)}${i}`),
        updated_at: T0,
      },
      receivedAt: T0,
    });
    const sets = computeMessageAnnotations(db, "c1").reactions["env-1"] ?? [];
    expect(sets).toHaveLength(1);
    expect(sets[0]?.emojis.length).toBeLessThanOrEqual(8);
    for (const e of sets[0]?.emojis ?? []) expect(e.length).toBeLessThanOrEqual(16);
  });

  it("breaks same-timestamp ties on the replicated event_hash (deterministic)", () => {
    // Two pin flips with IDENTICAL updated_at: every node must agree, and the
    // winner is the greater hash regardless of arrival order.
    insertEvent(db, {
      author: "ed25519:a",
      type: "message.pin",
      body: { target_envelope_id: "env-1", pinned: true, updated_at: T0 },
      receivedAt: T0,
      eventHash: "aaaa",
    });
    insertEvent(db, {
      author: "ed25519:b",
      type: "message.pin",
      body: { target_envelope_id: "env-1", pinned: false, updated_at: T0 },
      receivedAt: T0,
      eventHash: "bbbb",
    });
    expect(computeMessageAnnotations(db, "c1").pins).toEqual([]); // "bbbb" (unpin) wins
  });
});
