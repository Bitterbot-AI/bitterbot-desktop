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
    expect(answered.resolvedAt).toBeNull(); // survival window still open
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
    // The ledger was corroborated, not forked.
    expect(store.get("infra.gateway")!.value).toBe("a2a.new.example");
    expect(store.get("infra.gateway")!.mentionCount).toBeGreaterThanOrEqual(2);

    // 6. Same-cycle finalize is a no-op; the NEXT cycle resolves it.
    expect(
      finalizeAnsweredDirectives({ engine, canonicalStore: store, cutoffTs: cycle1 - 60_000 }),
    ).toBe(0);
    expect(
      finalizeAnsweredDirectives({ engine, canonicalStore: store, cutoffTs: Date.now() + 60_000 }),
    ).toBe(1);
    const resolved = engine.getDirective(question.id)!;
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution).toBe("a2a.new.example");

    // 7. Never re-injected, and the consumed conflict never re-sweeps.
    expect(engine.getDirectivesForSession({ sessionKey: "session-3" })).toHaveLength(0);
    expect(engine.sweepCanonicalConflicts()).toBe(0);
  });

  it("trust tiers hold for answers: an extraction-tier answer cannot overwrite a deliberate pin, and the contradicted answer never resolves", async () => {
    // The user deliberately pinned A; background extraction proposed B.
    store.pin({ key: "project.repo", value: "github.com/org/alpha", source: "user_directive" });
    store.pin({ key: "project.repo", value: "github.com/org/beta", source: "extraction" });
    engine.sweepCanonicalConflicts();
    const question = engine.listOpenDirectives(5)[0];

    // The owner answers with the EXTRACTION value. Routing stays a normal
    // reconciler proposal: extraction tier still cannot supersede the
    // deliberate pin (that requires memory_pin), so the ledger keeps A.
    applyDirectiveResolutions({
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
    expect(engine.getDirective(question.id)!.status).toBe("answered"); // stops asking
    expect(store.get("project.repo")!.value).toBe("github.com/org/alpha"); // tier held

    // Ledger value != stored answer -> contradicted -> never resolves.
    expect(
      finalizeAnsweredDirectives({ engine, canonicalStore: store, cutoffTs: Date.now() + 60_000 }),
    ).toBe(0);
    expect(engine.getDirective(question.id)!.resolvedAt).toBeNull();
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
