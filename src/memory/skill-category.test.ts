/**
 * Tests for canonical skill-key derivation + the v57 backfill (audit F12).
 *
 * Covers the pure helpers and backfillSkillCategories against a real
 * in-memory schema: frontmatter-name derivation, forage response-prefix
 * normalization, transitive parent inheritance (fixpoint), fallbacks, and
 * the never-rewrite-existing-categories guarantee.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  normalizeSkillKey,
  skillCategoryFromContent,
  backfillSkillCategories,
} from "./skill-category.js";

describe("normalizeSkillKey", () => {
  it("returns null for null/undefined/empty/whitespace", () => {
    expect(normalizeSkillKey(null)).toBeNull();
    expect(normalizeSkillKey(undefined)).toBeNull();
    expect(normalizeSkillKey("")).toBeNull();
    expect(normalizeSkillKey("   ")).toBeNull();
  });

  it("trims and passes plain names through", () => {
    expect(normalizeSkillKey("  docker-deploy ")).toBe("docker-deploy");
  });

  it("strips the forage response-<8hex>- prefix so responses group under their skill", () => {
    expect(normalizeSkillKey("response-705702b7-skill-f5e70aa9")).toBe("skill-f5e70aa9");
    expect(normalizeSkillKey("response-fd3116d9-521d0b75-f096")).toBe("521d0b75-f096");
  });

  it("does not strip non-hex or wrong-length prefixes", () => {
    expect(normalizeSkillKey("response-notahex1-x")).toBe("response-notahex1-x");
    expect(normalizeSkillKey("response-abc-x")).toBe("response-abc-x");
  });
});

describe("skillCategoryFromContent", () => {
  it("prefers the frontmatter name over the fallback", () => {
    const text = "---\nname: skill-abc\ndescription: d\n---\nbody";
    expect(skillCategoryFromContent(text, "envelope-name")).toBe("skill-abc");
  });

  it("normalizes a response-prefixed frontmatter name", () => {
    const text = "---\nname: response-705702b7-skill-abc\n---\n";
    expect(skillCategoryFromContent(text, null)).toBe("skill-abc");
  });

  it("falls back to the (normalized) name when text has no frontmatter name", () => {
    expect(skillCategoryFromContent("plain prose skill", "response-fd3116d9-my-skill")).toBe(
      "my-skill",
    );
  });

  it("only matches name: at line start (not toolName: etc)", () => {
    expect(skillCategoryFromContent("toolName: not-it\nsurname: nope x", "fb")).toBe("fb");
  });

  it("returns null when nothing is derivable", () => {
    expect(skillCategoryFromContent(null, null)).toBeNull();
    expect(skillCategoryFromContent("no frontmatter here")).toBeNull();
  });
});

describe("backfillSkillCategories", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
  });

  function insertSkillChunk(overrides: {
    id?: string;
    text?: string;
    path?: string;
    parent_id?: string | null;
    stable_skill_id?: string | null;
    skill_category?: string | null;
    memory_type?: string | null;
    semantic_type?: string;
  }): string {
    const id = overrides.id ?? crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO chunks (
        id, path, source, start_line, end_line, text, hash, model, embedding,
        updated_at, created_at, lifecycle_state, lifecycle,
        memory_type, semantic_type, parent_id, stable_skill_id, skill_category
      ) VALUES (?, ?, 'skills', 0, 0, ?, ?, 'test', '[]', ?, ?, 'active', 'generated', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      overrides.path ?? `peer/${id}`,
      overrides.text ?? "",
      crypto.randomUUID(),
      now,
      now,
      overrides.memory_type ?? null,
      overrides.semantic_type ?? "skill",
      overrides.parent_id ?? null,
      overrides.stable_skill_id ?? null,
      overrides.skill_category ?? null,
    );
    return id;
  }

  const categoryOf = (id: string): string | null =>
    (
      db.prepare(`SELECT skill_category FROM chunks WHERE id = ?`).get(id) as {
        skill_category: string | null;
      }
    ).skill_category;

  it("derives from frontmatter name, normalizing the response prefix", () => {
    const a = insertSkillChunk({ text: "---\nname: skill-aaa\n---\nbody" });
    const b = insertSkillChunk({
      text: "---\nname: response-705702b7-skill-aaa\n---\nbody",
      path: "peer/response-705702b7-skill-aaa",
    });
    const res = backfillSkillCategories(db);
    expect(res.updated).toBe(2);
    expect(res.unresolved).toBe(0);
    expect(categoryOf(a)).toBe("skill-aaa");
    expect(categoryOf(b)).toBe("skill-aaa");
  });

  it("inherits down a multi-level parent chain (fixpoint, any row order)", () => {
    // Insert child chain BEFORE the categorized root so a single ordered
    // pass could not resolve it — this is what the fixpoint loop is for.
    const grandchild = insertSkillChunk({
      id: "grandchild",
      text: "prose only",
      path: "dream/mutation/child",
      parent_id: "child",
    });
    const child = insertSkillChunk({
      id: "child",
      text: "prose only",
      path: "dream/mutation/root",
      parent_id: "root",
    });
    insertSkillChunk({ id: "root", text: "---\nname: root-skill\n---\n", path: "peer/root-skill" });
    backfillSkillCategories(db);
    expect(categoryOf("root")).toBe("root-skill");
    expect(categoryOf(child)).toBe("root-skill");
    expect(categoryOf(grandchild)).toBe("root-skill");
  });

  it("falls back to stable_skill_id, then path basename", () => {
    const viaStable = insertSkillChunk({
      text: "prose",
      path: "dream/mutation/x",
      stable_skill_id: "stable-123",
    });
    const viaPath = insertSkillChunk({ text: "prose", path: "peer/basename-skill" });
    backfillSkillCategories(db);
    expect(categoryOf(viaStable)).toBe("stable-123");
    expect(categoryOf(viaPath)).toBe("basename-skill");
  });

  it("never rewrites an existing category and ignores non-skill chunks", () => {
    const categorized = insertSkillChunk({
      text: "---\nname: something-else\n---\n",
      skill_category: "keep-me",
    });
    const nonSkill = crypto.randomUUID();
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, updated_at, created_at, semantic_type)
       VALUES (?, 'notes/x', 'memory', 0, 0, '---\nname: not-a-skill\n---', ?, 'test', '[]', 0, 0, 'general')`,
    ).run(nonSkill, crypto.randomUUID());
    const res = backfillSkillCategories(db);
    expect(res.updated).toBe(0);
    expect(categoryOf(categorized)).toBe("keep-me");
    expect(categoryOf(nonSkill)).toBeNull();
  });

  it("is idempotent — a second run updates nothing", () => {
    insertSkillChunk({ text: "---\nname: skill-aaa\n---\n" });
    insertSkillChunk({ text: "prose", path: "dream/mutation/x", stable_skill_id: "s1" });
    expect(backfillSkillCategories(db).updated).toBe(2);
    expect(backfillSkillCategories(db).updated).toBe(0);
  });
});
