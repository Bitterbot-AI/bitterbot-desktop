import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { CirclesStore } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { bindCollectiveCircles } from "./skill-packages.js";

const registered = vi.hoisted(() => ({ member: (_circle: string, _publisher: string) => false }));
vi.mock("../agents/skills/collective/runtime.js", () => ({
  registerCollectiveMembership: (check: typeof registered.member) => {
    registered.member = check;
  },
  getCollectiveRuntime: () => null,
}));

it("invalidates Circle authority when either the publisher or the local node leaves", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    const store = new CirclesStore(db),
      circle = store.createCircle({ name: "Research", creatorPubkey: "publisher" });
    store.addMember({ circleId: circle, memberPubkey: "self" });
    bindCollectiveCircles(db, "self");
    expect(registered.member(circle, "publisher")).toBe(true);
    store.removeMember(circle, "self");
    expect(registered.member(circle, "publisher")).toBe(false);
    store.addMember({ circleId: circle, memberPubkey: "self" });
    store.removeMember(circle, "publisher");
    expect(registered.member(circle, "publisher")).toBe(false);
  } finally {
    db.close();
  }
});
