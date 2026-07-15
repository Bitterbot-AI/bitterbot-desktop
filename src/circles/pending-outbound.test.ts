import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  consumePendingOutbound,
  createPendingOutbound,
  hashPendingParams,
  PENDING_OUTBOUND_TTL_MS,
} from "./pending-outbound.js";

// PLAN-36 §5.3: the server-enforced two-phase token. Covers the paths the
// agent-tool test can't easily reach (expiry via an injected clock).

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

describe("pending-outbound token", () => {
  let db: DatabaseSync;
  const NOW = 1_000_000;
  const hash = hashPendingParams("send", { circleId: "c1", text: "hi" });

  beforeEach(() => {
    db = openDb();
  });

  it("mints a token that consumes exactly once for the matching action+params", () => {
    const token = createPendingOutbound(db, "send", hash, NOW);
    expect(consumePendingOutbound(db, token, "send", hash, NOW)).toEqual({ ok: true });
    // Replay is refused.
    const replay = consumePendingOutbound(db, token, "send", hash, NOW);
    expect(replay.ok).toBe(false);
  });

  it("refuses a missing or unknown token", () => {
    expect(consumePendingOutbound(db, undefined, "send", hash, NOW).ok).toBe(false);
    expect(consumePendingOutbound(db, "does-not-exist", "send", hash, NOW).ok).toBe(false);
  });

  it("refuses a token whose action or params differ", () => {
    const token = createPendingOutbound(db, "send", hash, NOW);
    const otherHash = hashPendingParams("send", { circleId: "c1", text: "different" });
    expect(consumePendingOutbound(db, token, "send", otherHash, NOW).ok).toBe(false);
    expect(consumePendingOutbound(db, token, "ask", hash, NOW).ok).toBe(false);
    // The token was NOT consumed by the failed attempts — the right call works.
    expect(consumePendingOutbound(db, token, "send", hash, NOW)).toEqual({ ok: true });
  });

  it("refuses an expired token", () => {
    const token = createPendingOutbound(db, "send", hash, NOW);
    const later = NOW + PENDING_OUTBOUND_TTL_MS + 1;
    expect(consumePendingOutbound(db, token, "send", hash, later).ok).toBe(false);
  });
});
