/**
 * PLAN-54: the curiosity loop end to end against an in-memory database, with
 * fake search, fetch and model. Proves: gaps become deduped questions, the
 * phrase that leaves the node carries nothing personal, a verified answer
 * becomes a provenance-bearing fact the use ledger can count, an unverified
 * one does not, pause stops everything, and a newer answer supersedes an
 * older one without deleting it.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  insertNovelTargets,
  looksLikeOwnerQuestion,
  parseCuriosityGaps,
  researchableTargets,
} from "./curiosity-gaps.js";
import {
  abstractQuestion,
  admissiblePublicTerms,
  askCuriosity,
  curiosityStatus,
  dismissCuriosityTarget,
  findingIsVerified,
  listCuriosity,
  parseDistilled,
  phraseLeaks,
  resolveCuriosityResearchConfig,
  runCuriosityResearch,
  setCuriosityPaused,
  type CuriosityResearchDeps,
} from "./curiosity-researcher.js";
import { ensureCuriositySchema } from "./curiosity-schema.js";
import { curiosityRoiByRegion, curiosityUtility, recordCuriosityUse } from "./curiosity-use.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

const NOW = 1_800_000_000_000;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureCuriositySchema(db);
  runMigrations(db);
  return db;
}

/** Deterministic "embedding": a bag of letters, so similar strings are similar vectors. */
const fakeEmbed = async (text: string): Promise<number[]> => {
  const v = Array.from({ length: 26 }, () => 0);
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97;
    if (i >= 0 && i < 26) v[i]! += 1;
  }
  return v;
};

const MEMORY_MD = `# Working Memory State

## Active Context
- stuff

## Curiosity Gaps

- **Neoneye audit response strategy**: Should this bug trigger proactive community notification, or handle via quiet hotfix?
- (none)
- {What the agent wants to explore}
- short
- How is a libp2p relay's reservation quota enforced across circuits?

## Emerging Skills
- x
`;

describe("curiosity gaps", () => {
  it("parses only real questions out of the Curiosity Gaps section", () => {
    expect(parseCuriosityGaps(MEMORY_MD)).toEqual([
      "Neoneye audit response strategy: Should this bug trigger proactive community notification, or handle via quiet hotfix?",
      "How is a libp2p relay's reservation quota enforced across circuits?",
    ]);
    expect(parseCuriosityGaps("# nothing here")).toEqual([]);
  });

  it("dedupes near-duplicates against open and recently resolved targets", async () => {
    const db = openDb();
    const first = await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "How do libp2p relay reservations work?",
          priority: 0.7,
          metadata: {},
        },
        {
          type: "question",
          description: "How do libp2p relay reservations work",
          priority: 0.7,
          metadata: {},
        },
        {
          type: "question",
          description: "What is the capital of Mongolia?",
          priority: 0.5,
          metadata: {},
        },
      ],
      embed: fakeEmbed,
      now: NOW,
    });
    expect(first.length).toBe(2);
    // Resolve one; it must still block a re-ask for 30 days.
    db.prepare(`UPDATE curiosity_targets SET resolved_at = ? WHERE id = ?`).run(NOW, first[0]);
    const again = await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "How do libp2p relay reservations work?",
          priority: 0.7,
          metadata: {},
        },
      ],
      embed: fakeEmbed,
      now: NOW + 1000,
    });
    expect(again).toEqual([]);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("ranks researchable targets by priority, lifted by region ROI, lowered by attempts", () => {
    const db = openDb();
    const ins = db.prepare(
      `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, expires_at, attempts)
       VALUES (?, 'question', ?, ?, ?, '{"researchable":1}', ?, ?, ?)`,
    );
    ins.run("a", "A", 0.6, "r1", NOW, NOW + 1e6, 0);
    ins.run("b", "B", 0.7, null, NOW, NOW + 1e6, 0);
    ins.run("c", "C", 0.9, null, NOW, NOW + 1e6, 2); // exhausted
    const roi = new Map([["r1", 1]]);
    expect(
      researchableTargets(db, { now: NOW, limit: 5, regionRoi: roi }).map((t) => t.id),
    ).toEqual(["a", "b"]);
  });
});

describe("abstraction keeps private context on the node", () => {
  it("rejects phrases that leak a fragment, a name, or an address", () => {
    const q = "Should I tell Sylvia Martin about the APIMart sponsorship before Friday?";
    expect(phraseLeaks(q, "sponsorship disclosure timing etiquette")).toBe(false);
    expect(phraseLeaks(q, "tell Sylvia Martin about the sponsorship")).toBe(true);
    expect(phraseLeaks(q, "sponsorship advice for sylvia", ["Sylvia Martin"])).toBe(true);
    expect(phraseLeaks(q, "contact me@example.com", [])).toBe(true);
  });

  it("catches copied fragments, known names, and non-ASCII names, but lets one topical bigram through", () => {
    const q = "when is lena's birthday and what should i get her";
    expect(phraseLeaks(q, "lena birthday gift ideas", ["Lena"])).toBe(true); // a known name
    expect(phraseLeaks(q, "birthday gift ideas for a friend")).toBe(false);
    expect(phraseLeaks("where does Bo live now", "bo relocation", ["Bo"])).toBe(true); // 2-letter name
    expect(phraseLeaks("did 李雷 finish the report", "report deadline 李雷")).toBe(true); // non-ASCII token
    expect(phraseLeaks("how is the weather in the city", "weather in the city")).toBe(true); // 3 shared bigrams
    // The subject must survive abstraction: one shared bigram is a topic, not a leak.
    expect(
      phraseLeaks("what is the libp2p public network node count", "libp2p node count measurement"),
    ).toBe(false);
    expect(
      phraseLeaks(
        "what is the libp2p public network node count",
        "libp2p public network node count",
      ),
    ).toBe(true);
  });

  it("lets a declared public subject through, never a private name, and never a fragment beyond it", () => {
    const q =
      "How does the ProbeLab IPFS DHT crawler estimate the number of reachable libp2p nodes?";
    const names = ["Victor Gil", "Aubaine"];
    const pub = ["ProbeLab", "IPFS DHT", "libp2p"];
    expect(
      phraseLeaks(q, "ProbeLab IPFS DHT crawler libp2p node estimate", names, { publicTerms: pub }),
    ).toBe(false);
    expect(
      phraseLeaks(q, "ProbeLab IPFS DHT crawler libp2p node estimate", names, {
        publicTerms: pub,
        strict: true,
      }),
    ).toBe(true);
    // A private name declared "public" is still private.
    expect(
      phraseLeaks("What did Aubaine decide about pricing?", "Aubaine pricing decision", names, {
        publicTerms: ["Aubaine"],
      }),
    ).toBe(true);
    // Fragments outside the public terms still count.
    expect(
      phraseLeaks(q, "ProbeLab estimate the number of reachable nodes", names, {
        publicTerms: pub,
      }),
    ).toBe(true);
    // Only terms actually in the question are admissible.
    expect(
      admissiblePublicTerms(q, ["ProbeLab", "Kubernetes", "a b c d e", "Aubaine"], names),
    ).toEqual(["ProbeLab"]);
  });

  it("abstractQuestion reads the JSON form and falls back to a bare line", async () => {
    const json = async () => ({
      text: '{"phrase":"ProbeLab libp2p crawler node estimate","public_terms":["ProbeLab","libp2p"]}',
      costUsd: 0,
    });
    const q = "How does the ProbeLab crawler estimate reachable libp2p nodes?";
    expect((await abstractQuestion(q, json, ["Victor Gil"])).phrase).toBe(
      "ProbeLab libp2p crawler node estimate",
    );
    expect((await abstractQuestion(q, json, ["Victor Gil"], { strict: true })).phrase).toBeNull();
    const bare = async () => ({ text: "peer crawler node estimation\n", costUsd: 0 });
    expect((await abstractQuestion(q, bare, [])).phrase).toBe("peer crawler node estimation");
  });

  it("parses JSON inside code fences and ignores trailing remarks", () => {
    const d = parseDistilled(
      'Here you go:\n```json\n{"answer":"A","confidence":0.7,"supporting_sources":[1]}\n```\nHope that helps.',
    );
    expect(d).toEqual({ answer: "A", confidence: 0.7, supportingSources: [1] });
  });

  it("only owner-shaped questions become weak-search targets", () => {
    expect(looksLikeOwnerQuestion("Who and what is associated with Aubaine?")).toBe(true);
    expect(looksLikeOwnerQuestion("how do I rotate the relay signing key")).toBe(true);
    expect(looksLikeOwnerQuestion("recent goals tasks projects")).toBe(false);
    expect(looksLikeOwnerQuestion("technical patterns skills workflows")).toBe(false);
    expect(looksLikeOwnerQuestion('FINAL the value of get("scope_bridge")')).toBe(false);
    expect(looksLikeOwnerQuestion("Victor profile preferences work identity")).toBe(false);
  });

  it("abstractQuestion returns null when the model leaks", async () => {
    const leaky = async () => ({ text: "Should I tell Sylvia Martin about it", costUsd: 0.001 });
    const r = await abstractQuestion("Should I tell Sylvia Martin about it?", leaky);
    expect(r.phrase).toBeNull();
    const clean = async () => ({ text: '"disclosure timing etiquette"\n', costUsd: 0.001 });
    expect((await abstractQuestion("Should I tell Sylvia Martin about it?", clean)).phrase).toBe(
      "disclosure timing etiquette",
    );
  });
});

describe("distillation and verification", () => {
  it("parses the trailing JSON and applies the two-source rule", () => {
    const d = parseDistilled(
      'Some prose.\n{"answer":"Relays cap reservations per peer.","confidence":0.8,"supporting_sources":[1,2,2]}',
    );
    expect(d).toEqual({
      answer: "Relays cap reservations per peer.",
      confidence: 0.8,
      supportingSources: [1, 2],
    });
    expect(findingIsVerified(d!, 0.55)).toBe(true);
    expect(findingIsVerified({ ...d!, supportingSources: [1] }, 0.55)).toBe(true); // 0.8 >= 0.75
    expect(findingIsVerified({ ...d!, confidence: 0.6, supportingSources: [1] }, 0.55)).toBe(false);
    expect(parseDistilled("no json")).toBeNull();
  });
});

function deps(db: DatabaseSync, over: Partial<CuriosityResearchDeps> = {}): CuriosityResearchDeps {
  return {
    db,
    config: { intervalMinutes: 60, maxPerDay: 3, minConfidence: 0.55 },
    search: async () => [
      { title: "A", url: "https://a.example.org/x" },
      { title: "B", url: "https://b.example.net/y" },
    ],
    fetchPage: async (url) => ({ text: `Page ${url} `.repeat(40) }),
    llm: async (prompt) =>
      prompt.startsWith("Rewrite")
        ? { text: "relay reservation limits", costUsd: 0.001 }
        : {
            text: '{"answer":"Relays cap reservations per peer.","confidence":0.8,"supporting_sources":[1,2]}',
            costUsd: 0.004,
          },
    embed: fakeEmbed,
    hormonal: () => ({ dopamine: 0.5, cortisol: 0.3, oxytocin: 0.5 }),
    ownerNames: ["Victor Gil"],
    now: () => NOW,
    ...over,
  };
}

describe("the loop", () => {
  let db: DatabaseSync;
  beforeEach(async () => {
    db = openDb();
    await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "How are libp2p relay reservations limited per peer?",
          priority: 0.8,
          metadata: { source: "working_memory" },
        },
      ],
      embed: fakeEmbed,
      now: NOW,
    });
  });

  it("learns a verified answer with provenance, voices it once, and counts its use", async () => {
    const events: string[] = [];
    const s = await runCuriosityResearch(deps(db, { onEvent: (e) => events.push(e) }));
    expect(s).toMatchObject({ ran: true, attempted: 1, learned: 1 });
    expect(events).toEqual(["curiosity_progress"]);
    const listing = listCuriosity(db, { now: NOW });
    expect(listing.wondering).toEqual([]);
    expect(listing.learned).toHaveLength(1);
    const f = listing.learned[0]!;
    expect(f.sources.map((x) => x.url)).toEqual([
      "https://a.example.org/x",
      "https://b.example.net/y",
    ]);
    expect(f.usedCount).toBe(0);
    const chunk = db
      .prepare(`SELECT origin, epistemic_layer, evidence_refs, path FROM chunks WHERE id = ?`)
      .get(f.chunkId) as Record<string, string>;
    expect(chunk.origin).toBe("curiosity");
    expect(chunk.epistemic_layer).toBe("world_fact");
    expect(JSON.parse(chunk.evidence_refs)).toHaveLength(2);
    // Egress was logged, with the phrase, not the question.
    const egress = db
      .prepare(`SELECT seam, destination FROM research_egress_log ORDER BY rowid`)
      .all() as Array<{ seam: string; destination: string }>;
    expect(egress[0]).toEqual({ seam: "curiosity-search", destination: "web-search" });
    // The system-prompt block has one line to voice.
    expect(
      (
        db.prepare(`SELECT COUNT(*) n FROM research_findings WHERE surfaced_at IS NULL`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    // A conversation used it.
    expect(recordCuriosityUse(db, [f.chunkId!, "not-a-curiosity-chunk"], NOW + 5)).toBe(1);
    expect(curiosityUtility(db)).toMatchObject({ learned: 1, used: 1, roi: 1 });
  });

  it("does not store an unverified answer, retries once, then closes as unanswered", async () => {
    const weak = deps(db, {
      llm: async (p) =>
        p.startsWith("Rewrite")
          ? { text: "relay reservation limits", costUsd: 0 }
          : { text: '{"answer":"unclear","confidence":0.3,"supporting_sources":[1]}', costUsd: 0 },
    });
    expect((await runCuriosityResearch(weak)).outcomes).toEqual({ inconclusive: 1 });
    expect(listCuriosity(db, { now: NOW }).wondering[0]?.attempts).toBe(1);
    expect(curiosityUtility(db).learned).toBe(0);
    // What it saw is kept for the owner, unverified, and never becomes memory.
    const seen = listCuriosity(db, { now: NOW }).learned;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ verified: false, chunkId: null, answer: "unclear" });
    expect(
      (
        db.prepare(`SELECT COUNT(*) n FROM chunks WHERE origin = 'curiosity'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const second = await runCuriosityResearch({ ...weak, now: () => NOW + 2 * 3_600_000 });
    expect(second.outcomes).toEqual({ unanswered: 1 });
    expect(listCuriosity(db, { now: NOW }).closed[0]?.outcome).toBe("unanswered");
  });

  it("never sends a phrase that leaked, never researches a sensitive topic, and respects pause and budget", async () => {
    const leaky = deps(db, {
      llm: async () => ({ text: "libp2p relay reservations limited per peer", costUsd: 0 }),
    });
    expect((await runCuriosityResearch(leaky)).outcomes).toEqual({ containment_rejected: 1 });
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM research_egress_log`).get() as { n: number }).n,
    ).toBe(0);

    await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "What does my therapist mean by my diagnosis of depression?",
          priority: 0.9,
          metadata: {},
        },
      ],
      embed: fakeEmbed,
      now: NOW,
    });
    const r = await runCuriosityResearch(deps(db, { now: () => NOW + 3_600_000 }));
    expect(r.outcomes.sensitive_skipped).toBe(1);

    setCuriosityPaused(db, true);
    expect((await runCuriosityResearch(deps(db, { now: () => NOW + 7_200_000 }))).reason).toBe(
      "paused",
    );
    setCuriosityPaused(db, false);
    expect(
      curiosityStatus(db, resolveCuriosityResearchConfig({}), { searchConfigured: true, now: NOW })
        .paused,
    ).toBe(false);
    expect((await runCuriosityResearch(deps(db, { search: null }))).reason).toBe(
      "no web search configured",
    );
  });

  it("a newer answer supersedes the older chunk without deleting it", async () => {
    await runCuriosityResearch(deps(db));
    const old = listCuriosity(db, { now: NOW }).learned[0]!;
    // Same question asked again by the owner after the dedupe window.
    const id = await askCuriosity(
      db,
      "How are libp2p relay reservations limited per peer?",
      fakeEmbed,
      NOW + 31 * 864e5,
    );
    expect(id).not.toBeNull();
    // Point the new target at the same prior finding by reusing the target id lineage.
    db.prepare(`UPDATE curiosity_findings SET target_id = ? WHERE id = ?`).run(id, old.id);
    await runCuriosityResearch(deps(db, { now: () => NOW + 31 * 864e5 + 1 }));
    const learned = listCuriosity(db, { now: NOW + 31 * 864e5 + 1 }).learned;
    expect(learned).toHaveLength(2);
    expect(learned.find((l) => l.id === old.id)?.current).toBe(false);
    expect(learned.find((l) => l.id !== old.id)?.current).toBe(true);
    const oldChunk = db
      .prepare(`SELECT valid_time_end, lifecycle_state FROM chunks WHERE id = ?`)
      .get(old.chunkId) as Record<string, unknown>;
    expect(oldChunk.valid_time_end).not.toBeNull();
    expect(oldChunk.lifecycle_state).toBe("archived");
  });

  it("transient errors do not spend the budget, but three in a row count as an attempt", async () => {
    const flaky = deps(db, {
      llm: async () => {
        throw new Error("provider down");
      },
    });
    for (let i = 0; i < 3; i += 1) {
      const r = await runCuriosityResearch({ ...flaky, now: () => NOW + i * 3_600_000 * 2 });
      expect(r.outcomes).toEqual({ transient_error: 1 });
    }
    const st = curiosityStatus(db, resolveCuriosityResearchConfig({}), {
      searchConfigured: true,
      now: NOW + 4 * 3_600_000,
    });
    expect(st.today.attempted).toBe(1); // only the third one counted
    expect(listCuriosity(db, { now: NOW }).wondering[0]?.attempts).toBe(1);
  });

  it("a question whose phrase keeps leaking closes after the attempt limit instead of sitting open", async () => {
    const leaky = deps(db, {
      llm: async () => ({ text: "libp2p relay reservations limited per peer", costUsd: 0 }),
    });
    await runCuriosityResearch(leaky);
    await runCuriosityResearch({ ...leaky, now: () => NOW + 2 * 3_600_000 });
    const l = listCuriosity(db, { now: NOW + 2 * 3_600_000 });
    expect(l.wondering).toEqual([]);
    expect(l.closed[0]?.outcome).toBe("containment_rejected");
  });

  it("records each finding's own cost, not the running total", async () => {
    await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "What is the capital of Mongolia?",
          priority: 0.7,
          metadata: {},
        },
      ],
      embed: fakeEmbed,
      now: NOW,
    });
    const s = await runCuriosityResearch(deps(db));
    expect(s.learned).toBe(2);
    const costs = listCuriosity(db, { now: NOW }).learned.map((f) => f.costUsd);
    expect(costs).toEqual([0.005, 0.005]);
    expect(curiosityUtility(db).costUsd).toBeCloseTo(0.01, 6);
  });

  it("maxOpen counts only researchable questions, so engine rows cannot starve ingestion", async () => {
    const ins = db.prepare(
      `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
       VALUES (?, 'stale_region', ?, 0.5, '{"source":"gccrf"}', ?, ?)`,
    );
    for (let i = 0; i < 20; i += 1) ins.run(`r${i}`, `region ${i} stuck`, NOW, NOW + 1e6);
    const ids = await insertNovelTargets(db, {
      targets: [
        {
          type: "question",
          description: "Why do relays drop idle circuits?",
          priority: 0.6,
          metadata: {},
        },
      ],
      embed: fakeEmbed,
      now: NOW,
    });
    expect(ids).toHaveLength(1);
  });

  it("hormones widen or narrow the day's budget and the owner can dismiss", async () => {
    const dopa = curiosityStatus(db, resolveCuriosityResearchConfig({ maxPerDay: 6 }), {
      searchConfigured: true,
      now: NOW,
      hormonal: { dopamine: 0.9, cortisol: 0.1 },
    });
    expect(dopa.today.budget).toBe(8);
    const cort = curiosityStatus(db, resolveCuriosityResearchConfig({ maxPerDay: 6 }), {
      searchConfigured: true,
      now: NOW,
      hormonal: { dopamine: 0.1, cortisol: 0.9 },
    });
    expect(cort.today.budget).toBe(4);
    const open = listCuriosity(db, { now: NOW }).wondering[0]!;
    expect(dismissCuriosityTarget(db, open.id, NOW)).toBe(true);
    expect(listCuriosity(db, { now: NOW }).closed[0]).toMatchObject({
      id: open.id,
      outcome: "dismissed",
    });
    expect(curiosityRoiByRegion(db).size).toBe(0);
    // Legacy flag still turns it off.
    expect(resolveCuriosityResearchConfig(undefined, false).enabled).toBe(false);
    expect(resolveCuriosityResearchConfig({ enabled: true }, false).enabled).toBe(true);
  });
});
