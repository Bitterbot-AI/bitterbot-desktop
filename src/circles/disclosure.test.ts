import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  BUILTIN_ALLOWED_CATEGORIES,
  isDisclosureAllowed,
  listDisclosureGrants,
  pendingAsks,
  setDisclosureGrant,
} from "./disclosure.js";

// PLAN-31 §3.5: default-deny disclosure. Precedence under test:
// circle-specific > wildcard > built-in > deny, with explicit revocation
// overriding built-ins.

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

describe("disclosure grants", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDb();
  });

  it("default-denies everything except the two built-ins", () => {
    expect(isDisclosureAllowed(db, "presence", "c1")).toBe(true);
    expect(isDisclosureAllowed(db, "availability", "c1")).toBe(true);
    expect(isDisclosureAllowed(db, "recommendations.dentist", "c1")).toBe(false);
    expect(isDisclosureAllowed(db, "memory", "c1")).toBe(false);
    expect(BUILTIN_ALLOWED_CATEGORIES.size).toBe(2);
  });

  it("wildcard grants allow, circle-specific rows override wildcard", () => {
    setDisclosureGrant(db, { category: "recommendations.dentist", allowed: true, now: NOW });
    expect(isDisclosureAllowed(db, "recommendations.dentist", "c1")).toBe(true);
    expect(isDisclosureAllowed(db, "Recommendations.Dentist", "c2")).toBe(true); // normalized
    // Revoke for one circle only.
    setDisclosureGrant(db, {
      category: "recommendations.dentist",
      circleId: "c1",
      allowed: false,
      now: NOW,
    });
    expect(isDisclosureAllowed(db, "recommendations.dentist", "c1")).toBe(false);
    expect(isDisclosureAllowed(db, "recommendations.dentist", "c2")).toBe(true);
  });

  it("explicit revocation overrides the built-ins (presence can be turned off)", () => {
    setDisclosureGrant(db, { category: "presence", allowed: false, now: NOW });
    expect(isDisclosureAllowed(db, "presence", "c1")).toBe(false);
    // And re-granted.
    setDisclosureGrant(db, { category: "presence", allowed: true, now: NOW + 1 });
    expect(isDisclosureAllowed(db, "presence", "c1")).toBe(true);
    expect(listDisclosureGrants(db)).toHaveLength(1);
  });

  it("lists pending asks with parsed categories and excludes answered threads", () => {
    const insert = db.prepare(
      `INSERT INTO circle_messages
         (message_id, circle_id, author_pubkey, direction, kind, thread_id, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("m1", "c1", "ed25519:bob", "in", "ask", "recommendations.dentist:t1", "q1", NOW);
    insert.run("m2", "c1", "ed25519:bob", "in", "ask", "no-category-uuid", "q2", NOW + 1);
    insert.run("m3", "c1", "ed25519:carol", "in", "ask", "schedule:t3", "q3", NOW + 2);
    // t3 already answered by us.
    insert.run("a3", "c1", "ed25519:me", "out", "answer", "schedule:t3", "sure", NOW + 3);

    const pending = pendingAsks(db);
    expect(pending.map((p) => p.messageId)).toEqual(["m1", "m2"]);
    expect(pending[0]?.category).toBe("recommendations.dentist");
    expect(pending[1]?.category).toBeNull();
  });
});
