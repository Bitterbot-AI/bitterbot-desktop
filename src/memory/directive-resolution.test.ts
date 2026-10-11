/**
 * PLAN-34 Phase 1 — acceptance: the loop closes end to end, seeded through
 * the canonical-conflict producer (never a hand-inserted directive row).
 *
 * conflict event -> sweep -> contradiction question -> injected once in a
 * session -> transcript containing the owner's answer -> answered
 * immediately (stops injecting) -> answer stored as a retrievable
 * world_fact crystal + reconciled into the ledger -> resolved on the NEXT
 * cycle -> never re-injected. Plus: trust tiers hold even for answers (an
 * extraction-tier answer cannot overwrite a deliberate pin, and the
 * contradicted answer never resolves).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalFactsStore } from "./canonical-facts.js";
import {
  applyDirectiveResolutions,
  canonicalKeyForDirective,
  finalizeAnsweredDirectives,
} from "./directive-resolution.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { extractSessionFacts } from "./session-extractor.js";

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

const handover = { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] };

describe("PLAN-34 Phase 1 — closed directive loop (acceptance)", () => {
  let db: DatabaseSync;
  let engine: EpistemicDirectiveEngine;
  let store: CanonicalFactsStore;

  beforeEach(() => {
    db = makeDb();
    engine = new EpistemicDirectiveEngine(db);
    store = new CanonicalFactsStore(db);
  });

  it("closes the loop: conflict -> question -> owner answer -> answered -> pinned -> resolved -> never re-asked", async () => {
    // 1. Fuel: an equal-tier rapid flip of a corroborated belief.
    store.pin({ key: "infra.gateway", value: "a2a.old.example", source: "extraction" });
    store.pin({ key: "infra.gateway", value: "a2a.old.example", source: "extraction" });
    expect(
      store.pin({ key: "infra.gateway", value: "a2a.new.example", source: "extraction" }).op,
    ).toBe("supersede");

    // 2. Extraction-cycle sweep turns the conflict into a question.
    expect(engine.sweepCanonicalConflicts()).toBe(1);
    const open = engine.listOpenDirectives(5);
    expect(open).toHaveLength(1);
    const question = open[0];
    expect(canonicalKeyForDirective(question)).toBe("infra.gateway");

    // 3. Injected once in a live session.
    const injected = engine.getDirectivesForSession({ sessionKey: "session-1" });
    expect(injected.map((d) => d.id)).toEqual([question.id]);
    engine.getDirectivesForSession({ sessionKey: "session-1" }); // later turn, no double count
    expect(engine.getDirective(question.id)!.attempts).toBe(1);

    // 4. The owner answers in conversation; the extractor quotes it.
    const transcript =
      `Assistant: ${question.question}\n` +
      `User: the gateway is a2a.new.example now, we cut over yesterday`;
    const llmCall = async () =>
      JSON.stringify({
        facts: [],
        handover,
        resolutions: [{ id: question.id, answer: "a2a.new.example", lines: [2], confidence: 0.9 }],
      });
    const result = await extractSessionFacts(
      transcript,
      "/sessions/owner.jsonl",
      llmCall,
      20,
      undefined,
      undefined,
      open.map((d) => ({ id: d.id, question: d.question })),
    );
    expect(result!.resolutions).toHaveLength(1);

    // 5. Apply: answered immediately, crystal written, ledger strengthened.
    const cycle1 = Date.now();
    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: result!.resolutions,
      sessionPath: "/sessions/owner.jsonl",
      now: cycle1,
    });
    expect(applied).toEqual({ answered: 1, pinned: 1 });

    const answered = engine.getDirective(question.id)!;
    expect(answered.status).toBe("answered");
    // PLAN-55 Phase 1 review (item 2): the owner picking an offered value is
    // an owner-tier write, which settles the question on the spot.
    expect(answered.resolvedAt).not.toBeNull();
    expect(answered.resolution).toBe("a2a.new.example");
    expect(engine.getDirectivesForSession({ sessionKey: "session-2" })).toHaveLength(0);

    // The answer is a retrievable crystal with transcript evidence.
    const crystal = db
      .prepare(
        `SELECT text, epistemic_layer, evidence_refs FROM chunks
         WHERE epistemic_layer = 'world_fact' AND text LIKE '%a2a.new.example%'`,
      )
      .get() as { text: string; epistemic_layer: string; evidence_refs: string };
    expect(crystal).toBeDefined();
    expect(JSON.parse(crystal.evidence_refs)).toEqual([
      { kind: "session", path: "/sessions/owner.jsonl", line: 2 },
    ]);
    // The ledger was corroborated, not forked, and now carries the owner's authority.
    expect(store.get("infra.gateway")!.value).toBe("a2a.new.example");
    expect(store.get("infra.gateway")!.mentionCount).toBeGreaterThanOrEqual(2);
    expect(store.get("infra.gateway")!.source).toBe("owner");

    // 6. Finalize has nothing left to do: the answer settled the directive.
    expect(
      finalizeAnsweredDirectives({ engine, canonicalStore: store, cutoffTs: cycle1 - 60_000 }),
    ).toBe(0);
    expect(
      finalizeAnsweredDirectives({ engine, canonicalStore: store, cutoffTs: Date.now() + 60_000 }),
    ).toBe(0);
    const resolved = engine.getDirective(question.id)!;
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution).toBe("a2a.new.example");

    // 7. Never re-injected, and the consumed conflict never re-sweeps.
    expect(engine.getDirectivesForSession({ sessionKey: "session-3" })).toHaveLength(0);
    expect(engine.sweepCanonicalConflicts()).toBe(0);
  });

  it("PLAN-55 Phase 1 review (item 2): a held agent supersede -> question -> the owner's answer settles it at owner tier", () => {
    // The owner pinned A; the agent tried B and was held (pending_supersede).
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "owner" });
    expect(
      store.pin({ key: "project.repo", value: "github.com/org/beta", source: "agent_pin" }).op,
    ).toBe("held");
    expect(engine.sweepCanonicalConflicts()).toBe(1);
    const question = engine.listOpenDirectives(5)[0]!;
    expect(question.question).toMatch(/Which is current for project.repo/);

    // The owner answers with the AGENT's value: one of the two offered
    // candidates, so it is the owner's own choice and lands at owner tier
    // (an extraction-tier pin would have been rejected by the very tier
    // that caused the hold, leaving the question unsettleable).
    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: [
        {
          directiveId: question.id,
          answer: "github.com/org/beta",
          confidence: 0.9,
          evidence: [{ kind: "session", path: "/sessions/owner.jsonl", line: 2 }],
        },
      ],
      sessionPath: "/sessions/owner.jsonl",
      now: Date.now(),
    });
    expect(applied).toEqual({ answered: 1, pinned: 1 });
    expect(store.get("project.repo")).toMatchObject({
      value: "github.com/org/beta",
      source: "owner",
      evidenceRef: "session:/sessions/owner.jsonl#L2",
    });
    const done = engine.getDirective(question.id)!;
    expect(done.status).toBe("answered");
    expect(done.resolvedAt).not.toBeNull();
    expect(engine.listOpenDirectives(5)).toEqual([]);
    expect(store.listPendingSupersedes()).toEqual([]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM canonical_conflicts WHERE consumed_at IS NULL`).get(),
    ).toEqual({ n: 0 });
    // Audit names the actor.
    const audit = db
      .prepare(`SELECT metadata FROM memory_audit_log WHERE event = 'owner_pin_fact'`)
      .all() as Array<{ metadata: string }>;
    expect(JSON.parse(audit.at(-1)!.metadata)).toMatchObject({ actor: "directive_answer" });
    // Nothing to re-ask: a later sweep creates nothing.
    expect(engine.sweepCanonicalConflicts()).toBe(0);
  });

  it("PLAN-55 Phase 1 review (item 2): the owner settling the key through memory.pinFact closes the open question too", () => {
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "owner" });
    store.pin({ key: "project.repo", value: "github.com/org/beta", source: "agent_pin" });
    engine.sweepCanonicalConflicts();
    expect(engine.listOpenDirectives(5)).toHaveLength(1);
    // The owner restates the original value (Memory page, RPC, or a chat
    // correction): a strengthen at owner tier.
    expect(
      store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "owner" }).op,
    ).toBe("strengthen");
    expect(engine.listOpenDirectives(5)).toEqual([]);
    expect(store.get("project.repo")?.value).toBe("github.com/org/alpha");
  });

  it("candidate constraint: a deictic or off-candidate quote answers the question but never moves the ledger", () => {
    store.pin({ key: "infra.host", value: "h1.example", source: "extraction" });
    store.pin({ key: "infra.host", value: "h1.example", source: "extraction" });
    store.pin({ key: "infra.host", value: "h2.example", source: "extraction" });
    engine.sweepCanonicalConflicts();
    const question = engine.listOpenDirectives(5)[0];

    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: [
        {
          directiveId: question.id,
          answer: "the first one is right", // honest deictic quote
          confidence: 0.9,
          evidence: [{ kind: "session", path: "/s.jsonl", line: 1 }],
        },
      ],
      sessionPath: "/s.jsonl",
      now: Date.now(),
    });
    expect(applied).toEqual({ answered: 1, pinned: 0 }); // no garbage pin
    expect(store.get("infra.host")!.value).toBe("h2.example"); // ledger unmoved
    expect(engine.getDirective(question.id)!.status).toBe("answered");
  });

  it("candidate constraint: selectedValue maps a deictic reply onto a candidate and pins it", () => {
    store.pin({ key: "infra.region", value: "us-east-1", source: "extraction" });
    store.pin({ key: "infra.region", value: "us-east-1", source: "extraction" });
    store.pin({ key: "infra.region", value: "eu-west-1", source: "extraction" });
    engine.sweepCanonicalConflicts();
    const question = engine.listOpenDirectives(5)[0];

    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: [
        {
          directiveId: question.id,
          answer: "the first one, us-east", // the quote itself is not a candidate
          selectedValue: "us-east-1", // but the mapping is candidate-exact
          confidence: 0.9,
          evidence: [{ kind: "session", path: "/s.jsonl", line: 1 }],
        },
      ],
      sessionPath: "/s.jsonl",
      now: Date.now(),
    });
    expect(applied).toEqual({ answered: 1, pinned: 1 });
    expect(store.get("infra.region")!.value).toBe("us-east-1"); // adjudicated back
    // Resolution stores the adjudicated candidate, keeping the survival
    // check coherent with the pin.
    expect(engine.getDirective(question.id)!.resolution).toBe("us-east-1");
  });

  it("candidate constraint: a hallucinated selectedValue outside the candidate set never pins", () => {
    store.pin({ key: "infra.cdn", value: "cdn-a.example", source: "extraction" });
    store.pin({ key: "infra.cdn", value: "cdn-a.example", source: "extraction" });
    store.pin({ key: "infra.cdn", value: "cdn-b.example", source: "extraction" });
    engine.sweepCanonicalConflicts();
    const question = engine.listOpenDirectives(5)[0];

    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: [
        {
          directiveId: question.id,
          answer: "we should really use cdn-evil",
          selectedValue: "cdn-evil.example",
          confidence: 0.95,
          evidence: [{ kind: "session", path: "/s.jsonl", line: 1 }],
        },
      ],
      sessionPath: "/s.jsonl",
      now: Date.now(),
    });
    expect(applied).toEqual({ answered: 1, pinned: 0 });
    expect(store.get("infra.cdn")!.value).toBe("cdn-b.example");
  });

  it("low-confidence answers never mark a question answered", () => {
    store.pin({ key: "infra.host", value: "h1.example", source: "extraction" });
    store.pin({ key: "infra.host", value: "h1.example", source: "extraction" });
    store.pin({ key: "infra.host", value: "h2.example", source: "extraction" });
    engine.sweepCanonicalConflicts();
    const question = engine.listOpenDirectives(5)[0];

    const applied = applyDirectiveResolutions({
      db,
      engine,
      canonicalStore: store,
      resolutions: [
        {
          directiveId: question.id,
          answer: "h2.example",
          confidence: 0.5, // below the 0.75 floor
          evidence: [{ kind: "session", path: "/s.jsonl", line: 1 }],
        },
      ],
      sessionPath: "/s.jsonl",
      now: Date.now(),
    });
    expect(applied).toEqual({ answered: 0, pinned: 0 });
    expect(engine.getDirective(question.id)!.status).toBe("open");
  });
});
