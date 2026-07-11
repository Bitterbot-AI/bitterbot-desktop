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
    store.pin({ key: "project.one", value: "alpha", source: "agent_pin", confidence: 0.95 });
    store.pin({ key: "project.two", value: "beta", source: "agent_pin", confidence: 0.9 });
    store.pin({ key: "project.low", value: "gamma", source: "promotion", confidence: 0.3 });
    // Confirm project.one again so it clearly outranks.
    store.pin({ key: "project.one", value: "alpha", source: "extraction" });
    store.pin({ key: "project.new", value: "delta", source: "agent_pin", confidence: 0.95 });
    const active = store.listActive().map((f) => f.key);
    expect(active.length).toBe(3);
    expect(active).not.toContain("project.low"); // lowest score demoted
    expect(active).toContain("project.new");
    // Demoted, not deleted: still the current belief for its key.
    expect(store.get("project.low")?.status).toBe("retired");
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

describe("trust-tier supersession (PLAN-33 Phase 3)", () => {
  it("background sources cannot overwrite deliberate pins", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "right/repo", source: "agent_pin", confidence: 0.95 });

    const promo = store.pin({ key: "project.repo", value: "wrong/repo", source: "promotion" });
    expect(promo.op).toBe("rejected");
    const extract = store.pin({ key: "project.repo", value: "wrong/repo", source: "extraction" });
    expect(extract.op).toBe("rejected");
    expect(store.get("project.repo")?.value).toBe("right/repo");

    // An explicit pin (same tier) still supersedes — user corrections propagate.
    const userFix = store.pin({ key: "project.repo", value: "new/repo", source: "user_directive" });
    expect(userFix.op).toBe("supersede");
    expect(store.get("project.repo")?.value).toBe("new/repo");
  });

  it("corroboration is welcome from any tier (STRENGTHEN is never blocked) — but tier-0 counts separately (PLAN-34 Phase 2b)", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "right/repo", source: "agent_pin", confidence: 0.95 });
    const result = store.pin({ key: "project.repo", value: "right/repo", source: "promotion" });
    expect(result.op).toBe("strengthen");
    // Tier-0 agreement (promotion/web) goes to the corroboration counter,
    // never into mention_count/confidence/recency.
    const fact = store.get("project.repo")!;
    expect(fact.mentionCount).toBe(1);
    expect(fact.corroborationCount).toBe(1);
    // Tier >= 1 confirmation is the full strengthen, as before.
    store.pin({ key: "project.repo", value: "right/repo", source: "extraction" });
    expect(store.get("project.repo")!.mentionCount).toBe(2);
  });

  it("extraction supersedes promotion, and promotion supersedes promotion", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "infra.gateway", value: "old.example.com", source: "promotion" });
    expect(
      store.pin({ key: "infra.gateway", value: "new.example.com", source: "extraction" }).op,
    ).toBe("supersede");
    expect(
      store.pin({ key: "infra.gateway", value: "newer.example.com", source: "promotion" }).op,
    ).toBe("rejected"); // promotion (tier 0) < extraction (tier 1)
  });
});

describe("decayTick (PLAN-33 Phase 3)", () => {
  const DAY = 86_400_000;

  it("retires stale unconfirmed facts; confirmed facts survive", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const now = Date.now();

    // Promotion-entry confidence (0.6), as the dream mode pins it.
    store.pin({
      key: "infra.stale",
      value: "old.example.internal",
      source: "promotion",
      confidence: 0.6,
    });
    store.pin({
      key: "infra.confirmed",
      value: "live.example.internal",
      source: "promotion",
      confidence: 0.6,
    });
    for (let i = 0; i < 10; i++) {
      store.pin({ key: "infra.confirmed", value: "live.example.internal", source: "extraction" }); // heavily confirmed
    }
    // Age both by 200 days without confirmation.
    db.prepare(`UPDATE canonical_facts SET last_confirmed_at = ?`).run(now - 200 * DAY);

    const retired = store.decayTick(now);
    expect(retired).toBe(1);
    expect(store.get("infra.stale")?.status).toBe("retired");
    expect(store.get("infra.confirmed")?.status).toBe("active"); // frequency held it

    // Idempotent and interval-independent: a second tick changes nothing.
    expect(store.decayTick(now)).toBe(0);
  });

  it("never touches facts confirmed within the stale window", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const now = Date.now();
    store.pin({ key: "infra.fresh", value: "fresh.example.internal", source: "promotion" }); // low confidence but fresh
    expect(store.decayTick(now)).toBe(0);
    expect(store.get("infra.fresh")?.status).toBe("active");
  });
});

describe("background transient-shape guards (first-live-hour hotfix)", () => {
  it("rejects the observed junk shapes for background sources", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const bad = [
      { key: "world.current_time", value: "2026-07-10T11:39:00-04:00" }, // other-category + timestamp + transient key
      { key: "project.repo.clones.yesterday", value: "5,315" }, // count + moving window
      { key: "project.bounties.open", value: "3" }, // bare count
      { key: "mental_model.memory_grounding_failure", value: "true" }, // other category
      { key: "project.no_inference", value: "true" }, // boolean assertion
      { key: "project.latest_release", value: "v2" }, // transient key token
    ];
    for (const b of bad) {
      const r = store.pin({ ...b, source: "extraction" });
      expect(r.op, b.key).toBe("rejected");
    }
    expect(store.listActive().length).toBe(0);
  });

  it("still accepts durable identifier-shaped background pins", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const good = [
      { key: "project.repo", value: "github.com/Bitterbot-AI/bitterbot-desktop" },
      { key: "infra.gateway", value: "a2a.bitterbot.ai" },
      { key: "preference.editor", value: "vscode" },
      { key: "infra.node_version", value: "22.22.1" }, // dotted version, not a bare count
      { key: "identity.user_name", value: "Victor" },
    ];
    for (const g of good) {
      const r = store.pin({ ...g, source: "extraction" });
      expect(r.op, g.key).toBe("add");
    }
  });

  it("does not restrict deliberate pins — the user may pin anything valid", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    const r = store.pin({
      key: "project.launch_count",
      value: "3",
      source: "agent_pin",
    });
    expect(r.op).toBe("add");
  });
});

describe("conflict-event recording (PLAN-34 Phase 1 fuel)", () => {
  function conflicts(
    db: DatabaseSync,
  ): Array<{ key: string; kind: string; proposed_value: string }> {
    return db
      .prepare(`SELECT key, kind, proposed_value FROM canonical_conflicts ORDER BY created_at`)
      .all() as Array<{ key: string; kind: string; proposed_value: string }>;
  }

  it("a tier rejection records a tier_rejection conflict event", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "user_directive" });
    const r = store.pin({
      key: "project.repo",
      value: "github.com/org/beta",
      source: "extraction",
    });
    expect(r.op).toBe("rejected");
    const rows = conflicts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "project.repo",
      kind: "tier_rejection",
      proposed_value: "github.com/org/beta",
    });
  });

  it("a rapid same-key supersede of a corroborated belief records rapid_supersede", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "infra.gateway", value: "a2a.example.com", source: "extraction" });
    // Corroborate (mention_count -> 2, last_confirmed_at -> now)...
    store.pin({ key: "infra.gateway", value: "a2a.example.com", source: "extraction" });
    // ...then flip inside the window: supersedes AND records the ambiguity.
    const r = store.pin({ key: "infra.gateway", value: "gw.example.com", source: "extraction" });
    expect(r.op).toBe("supersede");
    const rows = conflicts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "rapid_supersede", proposed_value: "gw.example.com" });
  });

  it("uncorroborated or stale beliefs supersede silently", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    // Single mention: a plain correction, no conflict.
    store.pin({ key: "preference.editor", value: "vscode", source: "extraction" });
    expect(store.pin({ key: "preference.editor", value: "neovim", source: "extraction" }).op).toBe(
      "supersede",
    );
    // Corroborated but last confirmed outside the 72h window: silent too.
    store.pin({ key: "infra.region", value: "us-east-1", source: "extraction" });
    store.pin({ key: "infra.region", value: "us-east-1", source: "extraction" });
    db.prepare(`UPDATE canonical_facts SET last_confirmed_at = ? WHERE key = 'infra.region'`).run(
      Date.now() - 96 * 3_600_000,
    );
    expect(store.pin({ key: "infra.region", value: "eu-west-1", source: "extraction" }).op).toBe(
      "supersede",
    );
    expect(conflicts(db)).toHaveLength(0);
  });

  it("keeps at most one UNCONSUMED conflict per key (dream-cycle retries must not grow the table)", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "user_directive" });
    // The same background proposal rejected over and over (e.g. canonical
    // promotion retrying every dream cycle).
    for (let i = 0; i < 5; i++) {
      store.pin({ key: "project.repo", value: "github.com/org/beta", source: "promotion" });
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM canonical_conflicts WHERE consumed_at IS NULL`)
      .get() as { c: number };
    expect(count.c).toBe(1);
    // Once consumed, a fresh conflict may be recorded again.
    db.prepare(`UPDATE canonical_conflicts SET consumed_at = ?`).run(Date.now());
    store.pin({ key: "project.repo", value: "github.com/org/beta", source: "promotion" });
    const after = db
      .prepare(`SELECT COUNT(*) AS c FROM canonical_conflicts WHERE consumed_at IS NULL`)
      .get() as { c: number };
    expect(after.c).toBe(1);
  });

  it("conflict recording never breaks pin() when the table is missing (pre-v34 DB)", () => {
    const db = makeDb();
    db.exec(`DROP TABLE canonical_conflicts`);
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "a", source: "user_directive" });
    const r = store.pin({ key: "project.repo", value: "b", source: "extraction" });
    expect(r.op).toBe("rejected"); // the reject verdict itself is unaffected
  });
});

describe("web_research tier (PLAN-34 Phase 2b)", () => {
  it("web_research can never supersede any existing belief (tier 0 vs 1+)", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "extraction" });
    const r = store.pin({
      key: "project.repo",
      value: "github.com/org/evil",
      source: "web_research",
    });
    expect(r.op).toBe("rejected");
    expect(store.get("project.repo")!.value).toBe("github.com/org/alpha");
  });

  it("tier-0 strengthen is corroboration-only: no confidence motion, no recency refresh", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({
      key: "infra.gateway",
      value: "a2a.example.com",
      source: "extraction",
      confidence: 0.7,
    });
    const before = store.get("infra.gateway")!;

    const r = store.pin({ key: "infra.gateway", value: "a2a.example.com", source: "web_research" });
    expect(r.op).toBe("strengthen");
    const after = store.get("infra.gateway")!;
    expect(after.confidence).toBe(before.confidence); // no motion from tier 0
    expect(after.lastConfirmedAt).toBe(before.lastConfirmedAt); // no recency refresh
    expect(after.mentionCount).toBe(before.mentionCount); // separate counter
    expect(after.corroborationCount).toBe(1);
  });

  it("tier-0 strengthen cannot reactivate a retired fact", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db);
    store.pin({ key: "infra.old_host", value: "h1.example", source: "extraction" });
    store.retire("infra.old_host");
    const r = store.pin({ key: "infra.old_host", value: "h1.example", source: "web_research" });
    expect(r.op).toBe("strengthen");
    expect(store.get("infra.old_host")!.status).toBe("retired"); // stays retired
    // A tier-1 confirmation still reactivates, as before.
    store.pin({ key: "infra.old_host", value: "h1.example", source: "extraction" });
    expect(store.get("infra.old_host")!.status).toBe("active");
  });

  it("N repeated web strengthens never outrank or evict a deliberate pin", () => {
    const db = makeDb();
    // Room for all three so the web fact really ADDs then STRENGTHENs.
    const store = new CanonicalFactsStore(db, { maxFacts: 3 });
    store.pin({ key: "identity.user_name", value: "Victor", source: "user_directive" });
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "agent_pin" });
    expect(store.pin({ key: "infra.cdn", value: "cdn.example", source: "web_research" }).op).toBe(
      "add",
    );
    // Hammer the web fact with 25 real STRENGTHENs...
    for (let i = 0; i < 25; i++) {
      expect(store.pin({ key: "infra.cdn", value: "cdn.example", source: "web_research" }).op).toBe(
        "strengthen",
      );
    }
    const web = store.get("infra.cdn")!;
    expect(web.corroborationCount).toBe(25); // counted...
    expect(web.mentionCount).toBe(1); // ...but confidence/mentions never moved
    // Now a deliberate pin needs the slot: the web fact is the tier-0 victim,
    // never either deliberate pin.
    store.pin({ key: "infra.gateway", value: "gw.example", source: "user_directive" });
    expect(store.get("infra.cdn")!.status).toBe("retired");
    expect(store.get("identity.user_name")!.status).toBe("active");
    expect(store.get("project.repo")!.status).toBe("active");
  });

  it("tier-first eviction: a web_research ADD evicts only equal-or-lower-tier victims", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db, { maxFacts: 2 });
    store.pin({ key: "identity.user_name", value: "Victor", source: "user_directive" });
    store.pin({ key: "infra.old", value: "old.example", source: "web_research" });
    // Cap full: user_directive (tier 2) + web_research (tier 0). A new
    // web ADD may displace the tier-0 fact, never the deliberate pin.
    const r = store.pin({ key: "infra.new", value: "new.example", source: "web_research" });
    expect(r.op).toBe("add");
    expect(store.get("identity.user_name")!.status).toBe("active");
    expect(store.get("infra.old")!.status).toBe("retired");
  });

  it("corroboration contributes a hard-capped promotion-score bonus", () => {
    const base = { confidence: 0.8, mentionCount: 3, lastConfirmedAt: Date.now() };
    const now = Date.now();
    const plain = canonicalPromotionScore(base, now);
    const capped = canonicalPromotionScore({ ...base, corroborationCount: 1000 }, now);
    expect(capped).toBeGreaterThan(plain);
    expect(capped / plain).toBeLessThanOrEqual(1.05 + 1e-9); // hard cap: +5%
  });
});

describe("tier-first eviction atomicity (PLAN-34 Phase 2 adversarial fix)", () => {
  it("a rejected lower-tier ADD retires NOTHING (atomic — no partial evictions)", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db, { maxFacts: 2 });
    store.pin({ key: "identity.user_name", value: "Victor", source: "user_directive" });
    store.pin({ key: "project.repo", value: "github.com/org/a", source: "agent_pin" });
    // Ledger full of tier-2 facts; a tier-0 ADD cannot displace them.
    const r = store.pin({ key: "infra.cdn", value: "cdn.example", source: "web_research" });
    expect(r.op).toBe("rejected");
    // Both deliberate pins remain ACTIVE — nothing was retired.
    expect(store.get("identity.user_name")!.status).toBe("active");
    expect(store.get("project.repo")!.status).toBe("active");
    expect(store.listActive()).toHaveLength(2);
  });

  it("a same-tier ADD does not displace a higher-scored same-tier fact", () => {
    const db = makeDb();
    const store = new CanonicalFactsStore(db, { maxFacts: 1 });
    // A well-confirmed extraction fact holds the single slot.
    store.pin({ key: "infra.a", value: "v1", source: "extraction", confidence: 0.9 });
    store.pin({ key: "infra.a", value: "v1", source: "extraction" }); // strengthen
    // A fresh same-tier ADD (mention_count 1) scores lower → rejected.
    const r = store.pin({ key: "infra.b", value: "v2", source: "extraction", confidence: 0.3 });
    expect(r.op).toBe("rejected");
    expect(store.get("infra.a")!.status).toBe("active");
    expect(store.get("infra.b")).toBeNull();
  });
});
