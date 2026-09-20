import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isHeartbeatArtifact, sweepHeartbeatArtifacts } from "./canonical-facts-hygiene.js";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

describe("canonical-facts hygiene", () => {
  it("recognizes the heartbeat artifacts seen on the live node", () => {
    const junk: Array<[string, string]> = [
      ["project.heartbeat_file", "HEARTBEAT.md"],
      ["preference.heartbeat_reply", "HEARTBEAT_OK"],
      ["preference.heartbeat.md.follow", "strict"],
      [
        "preference.heartbeat_instruction",
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly",
      ],
      ["preference.no_old_tasks", "Do not infer or repeat old tasks from prior chats."],
      ["preference.workflow", "heartbeat checks via HEARTBEAT.md"],
      ["project.date", "2026-08-15"],
      ["project.time", "2026-08-15 16:02:00"],
      ["preference.reply_on_no_attention", "HEARTBEAT_OK"],
    ];
    for (const [k, v] of junk) {
      expect(isHeartbeatArtifact(k, v), `${k}=${v}`).toBe(true);
    }
  });

  it("keeps real facts", () => {
    const real: Array<[string, string]> = [
      ["identity.timezone", "America/Toronto"],
      ["preference.package_manager", "pnpm (not npm) for this repo"],
      ["relationship.spouse", "Donna"],
      ["project.repo", "Bitterbot-AI/bitterbot-desktop"],
      ["preference.search_tool", "ripgrep (rg), not grep"],
    ];
    for (const [k, v] of real) {
      expect(isHeartbeatArtifact(k, v), `${k}=${v}`).toBe(false);
    }
  });

  it("rejects heartbeat artifacts at pin() and sweeps stored ones idempotently", () => {
    const db = makeDb();
    // Seed junk directly (as the old extraction lane did), then construct the
    // store, whose constructor runs the sweep.
    const seed = db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence, mention_count,
         first_seen_at, last_confirmed_at, valid_from, valid_until, superseded_by, source,
         evidence_chunk_ids, status)
       VALUES (?, ?, ?, ?, 'project', 0.9, 1, 1, 1, 1, NULL, NULL, 'extraction', '[]', 'active')`,
    );
    seed.run("a", "project.heartbeat_file", "HEARTBEAT.md", "project.heartbeat_file: HEARTBEAT.md");
    seed.run("b", "identity.timezone", "America/Toronto", "identity.timezone: America/Toronto");
    const store = new CanonicalFactsStore(db);
    expect(store.get("project.heartbeat_file")?.status).toBe("retired");
    expect(store.get("identity.timezone")?.status).toBe("active");
    expect(sweepHeartbeatArtifacts(db)).toBe(0);

    const res = store.pin({
      key: "preference.heartbeat_reply",
      value: "HEARTBEAT_OK",
      source: "extraction",
    });
    expect(res.op).toBe("rejected");
    const ok = store.pin({ key: "preference.editor", value: "neovim", source: "agent_pin" });
    expect(ok.op).not.toBe("rejected");
  });
});
