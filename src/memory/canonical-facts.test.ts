/**
 * PLAN-33 Phase 1 — canonical facts ledger.
 *
 * The contract under test: exact key-value facts, one current belief per key,
 * closed reconcile op set (ADD / STRENGTHEN / SUPERSEDE / REJECT), bitemporal
 * supersession (nothing deleted), deterministic score-based cap demotion, and
 * a rendered block that is a pure projection of the table — the failure mode
 * this kills is canonical facts being paraphrased or evicted by LLM prose
 * rewrites and similarity gates.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CanonicalFactsStore,
  canonicalPromotionScore,
  normalizeCanonicalKey,
} from "./canonical-facts.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function makeDb(): DatabaseSync {
  // Production-faithful setup: base schema + full migration chain (incl. v33).
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

describe("migration v33", () => {
  it("creates canonical_facts with one-current-belief-per-key enforcement", () => {
    const db = makeDb();
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
        first_seen_at, last_confirmed_at, valid_from, source)
       VALUES (?, ?, 'v', 's', 'project', 0.9, ?, ?, ?, 'seed')`,
    );
    ins.run("a", "project.repo", now, now, now);
    expect(() => ins.run("b", "project.repo", now, now, now)).toThrow(); // partial unique index
    // A superseded (closed-window) row for the same key is allowed.
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
        first_seen_at, last_confirmed_at, valid_from, valid_until, source, status)
       VALUES ('c', 'project.repo', 'old', 's', 'project', 0.9, ?, ?, ?, ?, 'seed', 'superseded')`,
    ).run(now - 10, now - 10, now - 10, now);
    db.close();
  });
});

describe("normalizeCanonicalKey", () => {
  it("slugifies and validates", () => {
    expect(normalizeCanonicalKey("Project Repo")).toBe("project_repo");
    expect(normalizeCanonicalKey("project.repo")).toBe("project.repo");
    expect(normalizeCanonicalKey("  IDENTITY.User-Name ")).toBe("identity.user-name");
    expect(normalizeCanonicalKey("!!!")).toBeNull();
    expect(normalizeCanonicalKey("")).toBeNull();
  });
});

describe("CanonicalFactsStore reconcile verbs", () => {
  let db: DatabaseSync;
  let store: CanonicalFactsStore;

  beforeEach(() => {
    db = makeDb();
    store = new CanonicalFactsStore(db);
  });

  it("ADD inserts a new current belief", () => {
    const result = store.pin({
      key: "project.repo",
      value: "github.com/Bitterbot-AI/bitterbot-desktop",
      statement: "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.",
      category: "project",
      source: "agent_pin",
    });
    expect(result.op).toBe("add");
    const fact = store.get("project.repo");
    expect(fact?.value).toBe("github.com/Bitterbot-AI/bitterbot-desktop");
    expect(fact?.mentionCount).toBe(1);
    expect(fact?.status).toBe("active");
  });

  it("STRENGTHEN on re-pin of the same value — the daily-confirmation signal", () => {
    store.pin({ key: "project.repo", value: "repo-x", source: "agent_pin", confidence: 0.7 });
    const second = store.pin({ key: "project.repo", value: "repo-x", source: "extraction" });
    expect(second.op).toBe("strengthen");
    const fact = store.get("project.repo");
    expect(fact?.mentionCount).toBe(2);
    expect(fact?.confidence).toBeGreaterThan(0.7); // repetition finally strengthens
    // Paraphrase-duplication regression: strengthening never creates a second row.
    expect(store.history("project.repo").length).toBe(1);
  });

  it("SUPERSEDE on contradiction — old belief keeps its validity window", () => {
    store.pin({ key: "project.repo", value: "VGIL77/old-repo", source: "agent_pin" });
    const result = store.pin({
      key: "project.repo",
      value: "Bitterbot-AI/bitterbot-desktop",
      source: "agent_pin",
    });
    expect(result.op).toBe("supersede");
    const current = store.get("project.repo");
    expect(current?.value).toBe("Bitterbot-AI/bitterbot-desktop");
    const history = store.history("project.repo");
    expect(history.length).toBe(2);
    const old = history.find((f) => f.value === "VGIL77/old-repo");
    expect(old?.status).toBe("superseded");
    expect(old?.validUntil).not.toBeNull(); // window closed, not deleted
    expect(old?.supersededBy).toBe(current?.id);
  });

  it("REJECTS invalid input instead of writing partially", () => {
    expect(store.pin({ key: "??", value: "x", source: "agent_pin" }).op).toBe("rejected");
    expect(store.pin({ key: "ok.key", value: "  ", source: "agent_pin" }).op).toBe("rejected");
    expect(store.pin({ key: "ok.key", value: "y".repeat(600), source: "agent_pin" }).op).toBe(
      "rejected",
    );
    expect(store.get("ok.key")).toBeNull();
  });

  it("re-pinning a retired fact reactivates it via STRENGTHEN", () => {
    store.pin({ key: "infra.gateway", value: "a2a.bitterbot.ai", source: "agent_pin" });
    expect(store.retire("infra.gateway")).toBe(true);
    expect(store.listActive().length).toBe(0);
    const result = store.pin({
      key: "infra.gateway",
      value: "a2a.bitterbot.ai",
      source: "agent_pin",
    });
    expect(result.op).toBe("strengthen");
    expect(store.get("infra.gateway")?.status).toBe("active");
  });
});

describe("cap enforcement", () => {
  it("demotes the lowest promotion score deterministically, never deletes", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db, { maxFacts: 3 });
    store.pin({ key: "k.one", value: "1", source: "agent_pin", confidence: 0.95 });
    store.pin({ key: "k.two", value: "2", source: "agent_pin", confidence: 0.9 });
    store.pin({ key: "k.low", value: "3", source: "promotion", confidence: 0.3 });
    // Confirm k.one again so it clearly outranks.
    store.pin({ key: "k.one", value: "1", source: "extraction" });
    store.pin({ key: "k.new", value: "4", source: "agent_pin", confidence: 0.95 });
    const active = store.listActive().map((f) => f.key);
    expect(active.length).toBe(3);
    expect(active).not.toContain("k.low"); // lowest score demoted
    expect(active).toContain("k.new");
    // Demoted, not deleted: still the current belief for its key.
    expect(store.get("k.low")?.status).toBe("retired");
  });
});

describe("renderBlock", () => {
  it("renders a deterministic block ordered by promotion score", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({
      key: "project.repo",
      value: "github.com/Bitterbot-AI/bitterbot-desktop",
      statement: "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.",
      category: "project",
      source: "agent_pin",
      confidence: 0.95,
    });
    store.pin({
      key: "project.repo",
      value: "github.com/Bitterbot-AI/bitterbot-desktop",
      source: "extraction",
    });
    store.pin({
      key: "identity.user_name",
      value: "Victor",
      statement: "The user's name is Victor.",
      category: "identity",
      source: "seed",
      confidence: 0.8,
    });
    const block = store.renderBlock();
    expect(block).toContain("## Canonical Facts");
    expect(block).toContain(
      "[project.repo] The project repository is github.com/Bitterbot-AI/bitterbot-desktop.",
    );
    expect(block).toContain("confirmed 2x");
    expect(block).toContain("[identity.user_name]");
    // Exact string survives verbatim — the anti-paraphrase guarantee.
    expect(block).toContain("github.com/Bitterbot-AI/bitterbot-desktop");
  });

  it("filters by category (minimal prompt mode) and returns undefined when empty", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    expect(store.renderBlock()).toBeUndefined();
    store.pin({
      key: "preference.editor",
      value: "vscode",
      category: "preference",
      source: "seed",
    });
    store.pin({ key: "project.repo", value: "x/y", category: "project", source: "seed" });
    const minimal = store.renderBlock({ categories: ["identity", "project"] });
    expect(minimal).toContain("project.repo");
    expect(minimal).not.toContain("preference.editor");
  });

  it("includes whole facts only, within the token budget", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db, { budgetTokens: 100 }); // ~400 chars
    for (let i = 0; i < 20; i++) {
      store.pin({
        key: `k.fact${i}`,
        value: `value-${i}`,
        statement: `Statement number ${i} with a reasonably long body to consume budget quickly.`,
        source: "agent_pin",
      });
    }
    const block = store.renderBlock()!;
    expect(block.length).toBeLessThanOrEqual(400 + 10);
    // No truncated mid-line entries: every fact line is complete.
    for (const line of block.split("\n").filter((l) => l.startsWith("- ["))) {
      expect(line).toMatch(/\(since \d{4}-\d{2}-\d{2}\)$/);
    }
  });
});

describe("seedFromIdentityPreferences", () => {
  it("seeds identity prefs once, guarded by the meta flag", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const prefs = [
      { category: "identity", key: "user_name", value: "Victor", confidence: 0.9 },
      { category: "identity", key: "user_role", value: "neuroscientist", confidence: 0.7 },
      { category: "identity", key: "low_conf", value: "x", confidence: 0.3 }, // below floor
      { category: "tool", key: "editor", value: "vscode", confidence: 0.9 }, // wrong category
    ];
    expect(store.seedFromIdentityPreferences(prefs)).toBe(2);
    expect(store.get("identity.user_name")?.value).toBe("Victor");
    expect(store.get("identity.low_conf")).toBeNull();
    expect(store.get("identity.editor")).toBeNull();
    // Idempotent: second call is a no-op even with new prefs.
    expect(store.seedFromIdentityPreferences(prefs)).toBe(0);
  });
});

describe("canonicalPromotionScore", () => {
  it("rewards confirmation frequency and recency", () => {
    const now = Date.now();
    const fresh = { confidence: 0.8, mentionCount: 40, lastConfirmedAt: now };
    const stale = { confidence: 0.8, mentionCount: 1, lastConfirmedAt: now - 400 * 86_400_000 };
    expect(canonicalPromotionScore(fresh, now)).toBeGreaterThan(
      canonicalPromotionScore(stale, now),
    );
  });
});
