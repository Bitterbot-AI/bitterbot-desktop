/**
 * PLAN-64 Phase 1: recurring task types.
 *
 * Under test: content-word extraction (envelope, stopwords, stemming), the
 * overlap match on the real phrasings from the Phase 0 replay (four ways of
 * asking for repo stats must be one type; small talk and unrelated requests
 * must not join it), the recurring threshold (3 occurrences on 3 distinct
 * days), naming by one injected model call with a deterministic fallback,
 * retry de-duplication, the pending cap, and the preceding-turn lookup.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { PracticesStore } from "./practices.js";
import {
  buildTaskLabelPrompt,
  contentWords,
  fallbackTaskSlug,
  MAX_PENDING_TYPES,
  overlapCoefficient,
  parseTaskLabelResponse,
  parseTaskNamingResponse,
  stripMessageEnvelope,
  TaskTypesStore,
} from "./task-types.js";

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

const DAY = 24 * 3_600_000;
const T0 = new Date(2026, 10, 2, 9, 0, 0).getTime();

/** The owner's real ways of asking for repo stats (Phase 0 replay). */
const REPO_STATS = [
  "How many clones did your repo get yesterday?",
  "how did our npm's and clones do yesterday?",
  "Can you check npm, clones and views for yesterday for your repo?",
  "How did the repo do on clones and views yesterday?",
];
const UNRELATED = [
  "what's up my dude?",
  "Can you make me a cool fireworks display",
  "What is telematics?",
];

let store: TaskTypesStore;
beforeEach(() => {
  store = new TaskTypesStore(makeDb());
});

describe("contentWords", () => {
  it("drops the channel envelope, stopwords, possessives and plural or -ing endings", () => {
    expect(
      contentWords("[Fri 2026-11-27 09:14 EST] how did our npm's and clones do yesterday?"),
    ).toEqual(["npm", "clone", "yesterday"]);
    expect(contentWords("How many clones did your repo get yesterday?")).toEqual([
      "clone",
      "repo",
      "yesterday",
    ]);
    expect(contentWords("Stop asking where I live")).toEqual(["stop", "ask", "live"]);
  });

  it("strips the envelope only at the start and only when it carries a timestamp", () => {
    expect(stripMessageEnvelope("[Fri 2026-11-27 09:14 EST] hello")).toBe("hello");
    expect(stripMessageEnvelope("[WhatsApp +1555 2026-11-27 09:14 EST] hello")).toBe("hello");
    expect(stripMessageEnvelope("[note] hello")).toBe("[note] hello");
    expect(stripMessageEnvelope("see [Fri 2026-11-27 09:14 EST] later")).toBe(
      "see [Fri 2026-11-27 09:14 EST] later",
    );
  });

  it("overlap needs two shared words, whatever the ratio", () => {
    expect(overlapCoefficient(new Set(["repo"]), new Set(["repo", "clone"]))).toBe(0);
    expect(overlapCoefficient(new Set(["repo", "clone"]), new Set(["repo", "clone", "view"]))).toBe(
      1,
    );
  });
});

describe("TaskTypesStore.observe", () => {
  it("clusters the four real repo-stats phrasings into one type", () => {
    const slugs = REPO_STATS.map(
      (text, i) => store.observe(text, { now: T0 + i * DAY }).type?.slug,
    );
    expect(new Set(slugs).size).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ occurrences: 4, distinctDays: 4 });
  });

  it("clusters them with the channel envelope in front", () => {
    const a = store.observe(`[Mon 2026-11-02 09:00 EST] ${REPO_STATS[0]}`, { now: T0 });
    const b = store.observe(`[Tue 2026-11-03 09:02 EST] ${REPO_STATS[1]}`, { now: T0 + DAY });
    expect(b.type?.slug).toBe(a.type?.slug);
  });

  it("keeps small talk and unrelated requests out of the repo-stats type", () => {
    REPO_STATS.forEach((text, i) => store.observe(text, { now: T0 + i * DAY }));
    store.promoteWithFallback(store.list()[0]!.slug);
    const stats = store.list({ recurringOnly: true })[0]!;
    for (const text of UNRELATED) {
      expect(store.classify(text), text).toBeNull();
      expect(store.observe(text, { now: T0 + 5 * DAY }).type?.slug, text).not.toBe(stats.slug);
    }
    expect(store.get(stats.slug)).toMatchObject({ occurrences: 4 });
  });

  it("does not type a message with fewer than two content words", () => {
    expect(store.observe("What is telematics?", { now: T0 }).type).toBeNull();
    expect(store.observe("what's up my dude?", { now: T0 }).type).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("is recurring only at three occurrences on three distinct days", () => {
    const first = store.observe(REPO_STATS[0]!, { now: T0 });
    expect(first.needsPromotion).toBe(false);
    // Three occurrences, one day: not recurring.
    store.observe(REPO_STATS[1]!, { now: T0 + 60_000 });
    const sameDay = store.observe(REPO_STATS[2]!, { now: T0 + 120_000 });
    expect(sameDay.type).toMatchObject({ occurrences: 3, distinctDays: 1 });
    expect(sameDay.needsPromotion).toBe(false);
    // A second day: still not.
    expect(store.observe(REPO_STATS[3]!, { now: T0 + DAY }).needsPromotion).toBe(false);
    expect(store.classify(REPO_STATS[0]!)).toBeNull();
    // The third day.
    const third = store.observe(REPO_STATS[0]!, { now: T0 + 2 * DAY });
    expect(third.type).toMatchObject({ distinctDays: 3, recurring: false });
    expect(third.needsPromotion).toBe(true);
  });

  it("counts a retried attempt of the same run once", () => {
    store.observe(REPO_STATS[0]!, { now: T0, turnKey: "run-1" });
    const again = store.observe(REPO_STATS[0]!, { now: T0 + 5, turnKey: "run-1" });
    expect(again.duplicate).toBe(true);
    expect(store.list()[0]).toMatchObject({ occurrences: 1 });
  });

  it("caps pending types, dropping the least recently seen", () => {
    for (let i = 0; i < MAX_PENDING_TYPES + 20; i++) {
      store.observe(`alpha${i} bravo${i} charlie${i}`, { now: T0 + i });
    }
    const all = store.list();
    expect(all).toHaveLength(MAX_PENDING_TYPES);
    expect(all.some((t) => t.exemplars[0] === "alpha0 bravo0 charlie0")).toBe(false);
  });
});

describe("TaskTypesStore.promote", () => {
  function makeEligible(): string {
    let slug = "";
    REPO_STATS.slice(0, 3).forEach((text, i) => {
      slug = store.observe(text, { now: T0 + i * DAY }).type!.slug;
    });
    return slug;
  }

  it("names the type with one model call", async () => {
    const pending = makeEligible();
    const llm = vi.fn(async () => '{"slug":"Repo Stats","label":"repo stats"}');
    const type = await store.promote(pending, llm);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(type).toMatchObject({ slug: "repo-stats", label: "repo stats", recurring: true });
    expect(store.get(pending)).toBeNull();
    expect(store.classify(REPO_STATS[3]!)?.slug).toBe("repo-stats");
    // A second promote makes no second call.
    await store.promote("repo-stats", llm);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("falls back to a deterministic slug when the model fails or returns garbage", async () => {
    const pending = makeEligible();
    const type = await store.promote(
      pending,
      vi.fn(async () => "not json"),
    );
    expect(type?.recurring).toBe(true);
    expect(type?.slug).toBe(fallbackTaskSlug(REPO_STATS.slice(0, 3)));
    expect(type?.slug).toMatch(/clone/);

    const other = new TaskTypesStore(makeDb());
    let slug = "";
    REPO_STATS.slice(0, 3).forEach((text, i) => {
      slug = other.observe(text, { now: T0 + i * DAY }).type!.slug;
    });
    const thrown = await other.promote(
      slug,
      vi.fn(async () => {
        throw new Error("no model");
      }),
    );
    expect(thrown?.recurring).toBe(true);
  });

  it("does not promote a type that is not eligible", async () => {
    const slug = store.observe(REPO_STATS[0]!, { now: T0 }).type!.slug;
    expect(store.promoteWithFallback(slug)).toBeNull();
    expect(store.get(slug)?.recurring).toBe(false);
  });

  it("avoids a slug collision", async () => {
    const pending = makeEligible();
    await store.promote(pending, async () => '{"slug":"repo-stats","label":"repo stats"}');
    let second = "";
    [
      "weather forecast madrid",
      "madrid weather forecast please",
      "forecast weather madrid",
    ].forEach((text, i) => {
      second = store.observe(text, { now: T0 + (10 + i) * DAY }).type!.slug;
    });
    const type = await store.promote(second, async () => '{"slug":"repo-stats","label":"x"}');
    expect(type?.slug).toBe("repo-stats-2");
  });

  it("parses only a usable label response", () => {
    expect(
      parseTaskLabelResponse('```json\n{"slug":"repo-stats","label":"repo stats"}\n```'),
    ).toEqual({
      slug: "repo-stats",
      label: "repo stats",
    });
    expect(parseTaskLabelResponse('{"slug":"pending-abc"}')).toBeNull();
    expect(parseTaskLabelResponse('{"slug":"123"}')).toBeNull();
    expect(parseTaskLabelResponse('{"label":"x"}')).toBeNull();
    expect(parseTaskLabelResponse("nope")).toBeNull();
  });
});

describe("precedingRecurringType", () => {
  it("returns the recurring type of the owner turn just before this one, within the window", async () => {
    let pending = "";
    REPO_STATS.slice(0, 3).forEach((text, i) => {
      pending = store.observe(text, { now: T0 + i * DAY }).type!.slug;
    });
    await store.promote(pending, async () => '{"slug":"repo-stats","label":"repo stats"}');
    const session = "agent:main:main";
    const now = T0 + 4 * DAY;
    store.observe(REPO_STATS[3]!, { now, sessionKey: session, turnKey: "r1" });
    const followUp = "thanks, that one looks odd to me";
    // Before the follow-up is observed, and after (the prompt path observes it first).
    expect(store.precedingRecurringType(session, followUp, now + 1000)?.slug).toBe("repo-stats");
    store.observe(followUp, { now: now + 1000, sessionKey: session, turnKey: "r2" });
    expect(store.precedingRecurringType(session, followUp, now + 2000)?.slug).toBe("repo-stats");
    // Another session, or too late: nothing.
    expect(store.precedingRecurringType("agent:main:other", followUp, now)).toBeNull();
    expect(store.precedingRecurringType(session, followUp, now + 3 * 3_600_000)).toBeNull();
    // Two turns later the repo-stats turn is no longer the preceding one.
    store.observe("tell me a joke about penguins", {
      now: now + 3000,
      sessionKey: session,
      turnKey: "r3",
    });
    expect(
      store.precedingRecurringType(session, "tell me a joke about penguins", now + 4000),
    ).toBeNull();
  });
});

/**
 * PLAN-64 Phase 1b. A replay of the owner's real messages split one task
 * (repo and npm stats) into three recurring types. Under test: the naming
 * call can fold a new type into an existing one (`same_as`), the merge moves
 * exemplars, counts and practices, nothing merges without a model, a turn
 * inside a follow-up window does not found a type, and unrelated chat stays
 * out of the merged type.
 */
describe("merging task types (PLAN-64 Phase 1b)", () => {
  /** The three types the real replay produced, by their real phrasings. */
  const NPM_VARIANTS = [
    "how about our npm downloads",
    "How did our clones and npm downloads do the past few days?",
    "Give me day by day clones and the npm downloads too",
  ];
  // The first is the owner's real message; the other two are written for
  // this test so the type has three occurrences.
  const GITHUB_VARIANTS = [
    "Has github updated any of the traffic and clone stats for your repo?",
    "has github updated the traffic stats yet?",
    "did github update the clone and traffic stats?",
  ];

  /**
   * With a name: a recurring type holding exactly these phrasings (word
   * overlap is order dependent, so the split the replay produced is built
   * directly). Without: the texts are observed and stay a pending type.
   */
  function seedRecurring(texts: string[], startDay: number, name?: string): string {
    if (name) {
      store.adopt({
        slug: name,
        label: name.replace(/-/g, " "),
        exemplars: texts,
        occurrences: texts.length,
        distinctDays: texts.length,
        firstSeen: T0 + startDay * DAY,
        lastSeen: T0 + (startDay + texts.length - 1) * DAY,
        recurring: true,
      });
      return name;
    }
    let slug = "";
    texts.forEach((text, i) => {
      slug = store.observe(text, { now: T0 + (startDay + i) * DAY }).type!.slug;
    });
    return slug;
  }

  let db: DatabaseSync;
  let practices: PracticesStore;
  beforeEach(() => {
    db = makeDb();
    practices = new PracticesStore(db);
    store = new TaskTypesStore(db, {
      onMerge: (from, into) => practices.repointTaskScope(from, into),
    });
  });

  it("the naming prompt lists existing recurring types with two exemplars each", () => {
    const prompt = buildTaskLabelPrompt(NPM_VARIANTS, [
      { slug: "repo-stats", label: "repo stats", exemplars: REPO_STATS },
    ]);
    expect(prompt).toContain("repo-stats (repo stats)");
    expect(prompt).toContain(REPO_STATS[0]);
    expect(prompt).toContain(REPO_STATS[1]);
    expect(prompt).not.toContain(REPO_STATS[2]);
    expect(prompt).toContain('{"same_as":"repo-stats"}');
    // No existing types: the Phase 1 prompt, no same_as offer.
    expect(buildTaskLabelPrompt(NPM_VARIANTS)).not.toContain("same_as");
  });

  it("same_as counts only for a slug that was offered", () => {
    const offered = new Set(["repo-stats"]);
    expect(parseTaskNamingResponse('{"same_as":"repo-stats"}', offered)).toEqual({
      kind: "same",
      slug: "repo-stats",
    });
    expect(parseTaskNamingResponse('{"same_as":"something-else"}', offered)).toBeNull();
    expect(
      parseTaskNamingResponse('{"same_as":"nope","slug":"npm-stats","label":"npm stats"}', offered),
    ).toEqual({ kind: "new", slug: "npm-stats", label: "npm stats" });
    expect(parseTaskNamingResponse("not json", offered)).toBeNull();
  });

  it("naming with same_as folds the pending type into the existing one", async () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    const pending = seedRecurring(NPM_VARIANTS, 10);
    expect(store.get(pending)).toMatchObject({ recurring: false, occurrences: 3 });
    const llm = vi.fn(async () => '{"same_as":"repo-stats"}');
    const merged = await store.promote(pending, llm);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0]![0]).toContain("repo-stats (repo stats)");
    expect(merged).toMatchObject({ slug: "repo-stats", recurring: true, occurrences: 6 });
    expect(store.get(pending)).toBeNull();
    expect(store.list()).toHaveLength(1);
    // The folded-in phrasings now match the one type.
    for (const text of NPM_VARIANTS) {
      expect(store.classify(text)?.slug, text).toBe("repo-stats");
    }
  });

  it("without a model nothing is merged: the fallback name makes a second type", () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    const pending = seedRecurring(NPM_VARIANTS, 10);
    const promoted = store.promoteWithFallback(pending);
    expect(promoted?.slug).not.toBe("repo-stats");
    expect(store.list({ recurringOnly: true })).toHaveLength(2);
  });

  it("a model answer that is neither a known slug nor a name falls back, unmerged", async () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    const pending = seedRecurring(NPM_VARIANTS, 10);
    const promoted = await store.promote(pending, async () => '{"same_as":"made-up"}');
    expect(promoted?.recurring).toBe(true);
    expect(promoted?.slug).not.toBe("repo-stats");
    expect(store.get("repo-stats")).toMatchObject({ occurrences: 3 });
  });

  it("merge moves counts and exemplars, deletes the source and re-points its practices", () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    seedRecurring(NPM_VARIANTS, 10, "npm-download-clone");
    const moved = practices.upsert({
      statement: "Include npm downloads.",
      scope: "task:npm-download-clone",
      source: "owner",
    });
    const kept = practices.upsert({
      statement: "Give the numbers first.",
      scope: "task:repo-stats",
      source: "owner",
    });
    expect(moved.ok && kept.ok).toBe(true);
    const result = store.merge("npm-download-clone", "repo-stats");
    expect(result).toMatchObject({ ok: true, type: { slug: "repo-stats", occurrences: 6 } });
    expect(store.get("npm-download-clone")).toBeNull();
    const merged = store.get("repo-stats")!;
    expect(merged.exemplars).toEqual(expect.arrayContaining([...NPM_VARIANTS]));
    expect(merged.distinctDays).toBeGreaterThanOrEqual(3);
    expect(practices.list().map((p) => p.scope)).toEqual(["task:repo-stats", "task:repo-stats"]);
    expect(practices.listVisible({ taskSlug: "repo-stats" })).toHaveLength(2);
  });

  it("a practice that duplicates one at the target scope is folded into it, events and all", () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    seedRecurring(NPM_VARIANTS, 10, "npm-download-clone");
    const a = practices.upsert({
      statement: "Include npm downloads.",
      scope: "task:repo-stats",
      source: "extraction",
      evidenceRef: "session:a.jsonl#L1",
    });
    const b = practices.upsert({
      statement: "Include the npm downloads!",
      scope: "task:npm-download-clone",
      source: "owner",
      evidenceRef: "session:b.jsonl#L4",
    });
    if (!a.ok || !b.ok) {
      throw new Error("seed failed");
    }
    expect(store.merge("npm-download-clone", "repo-stats").ok).toBe(true);
    const rows = practices.list();
    expect(rows).toHaveLength(1);
    // The active duplicate makes the surviving row active.
    expect(rows[0]).toMatchObject({
      id: a.practice.id,
      scope: "task:repo-stats",
      status: "active",
      source: "owner",
      evidenceRefs: ["session:a.jsonl#L1", "session:b.jsonl#L4"],
    });
    expect(practices.events(a.practice.id).filter((e) => e.kind === "stored")).toHaveLength(2);
  });

  it("merge refuses an unknown slug or a self-merge and changes nothing", () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    expect(store.merge("repo-stats", "repo-stats")).toMatchObject({ ok: false });
    expect(store.merge("nope", "repo-stats")).toMatchObject({ ok: false });
    expect(store.merge("repo-stats", "nope")).toMatchObject({ ok: false });
    expect(store.get("repo-stats")).toMatchObject({ occurrences: 3 });
  });

  it("relabel folds an already recurring type into another, or renames it and re-points", async () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    seedRecurring(NPM_VARIANTS, 10, "npm-download-clone");
    seedRecurring(GITHUB_VARIANTS, 20, "github-updat-stat");
    practices.upsert({
      statement: "Say when the numbers were last refreshed.",
      scope: "task:github-updat-stat",
      source: "owner",
    });
    const renamed = await store.relabel(
      "github-updat-stat",
      async () => '{"slug":"stats-freshness","label":"stats freshness"}',
    );
    expect(renamed).toMatchObject({ slug: "stats-freshness", label: "stats freshness" });
    expect(practices.list()[0]?.scope).toBe("task:stats-freshness");
    const folded = await store.relabel(
      "npm-download-clone",
      async () => '{"same_as":"repo-stats"}',
    );
    expect(folded).toMatchObject({ slug: "repo-stats", occurrences: 6 });
    expect(
      store
        .list({ recurringOnly: true })
        .map((t) => t.slug)
        .toSorted(),
    ).toEqual(["repo-stats", "stats-freshness"]);
  });

  it("unrelated chat stays out of the merged stats type, and 'latest stats' is still a miss", async () => {
    seedRecurring(REPO_STATS, 0, "repo-stats");
    seedRecurring(NPM_VARIANTS, 10, "npm-download-clone");
    seedRecurring(GITHUB_VARIANTS, 20, "github-updat-stat");
    expect(store.merge("npm-download-clone", "repo-stats").ok).toBe(true);
    expect(store.merge("github-updat-stat", "repo-stats").ok).toBe(true);
    for (const text of [
      "what's up my dude?",
      "What is telematics?",
      "Can you make me a cool fireworks display",
      "Anything new in the mailbox?",
      "hmm, I wonder what drove the 68 unique clones",
      "Please coordinate with Codex on the collective-learning benchmark",
    ]) {
      expect(store.classify(text), text).toBeNull();
    }
    for (const text of [...REPO_STATS, ...NPM_VARIANTS, ...GITHUB_VARIANTS]) {
      expect(store.classify(text)?.slug, text).toBe("repo-stats");
    }
    // A known limit, kept on purpose (the threshold is not loosened): one
    // shared content word is not a match.
    expect(store.classify("Can you check the latest stats?")).toBeNull();
  });

  it("a turn in a follow-up window does not found or feed a type; it can be counted later", () => {
    seedRecurring(REPO_STATS.slice(0, 3), 0, "repo-stats");
    const before = store.list().length;
    const followUp = store.observe("how about our npm downloads", {
      now: T0 + 5 * DAY,
      sessionKey: "agent:main:main",
      followUpOf: "repo-stats",
    });
    expect(followUp).toMatchObject({ type: null, deferred: true });
    expect(store.list()).toHaveLength(before);
    // A turn that is the recurring task itself is counted as usual.
    const again = store.observe(REPO_STATS[0]!, {
      now: T0 + 5 * DAY,
      sessionKey: "agent:main:main",
      followUpOf: "repo-stats",
    });
    expect(again.deferred).toBeUndefined();
    expect(again.type).toMatchObject({ slug: "repo-stats", occurrences: 4 });
    // The follow-up check said "gap": dropped, never counted.
    store.dropDeferred("agent:main:main", "how about our npm downloads");
    expect(store.countDeferred("agent:main:main", "how about our npm downloads")).toBe(false);
    expect(store.list()).toHaveLength(before);
    // Another one turned out to be a new topic: counted once, afterwards.
    store.observe("Please review the wikiskills paper again", {
      now: T0 + 5 * DAY,
      sessionKey: "agent:main:main",
      followUpOf: "repo-stats",
    });
    expect(store.countDeferred("agent:main:main", "Please review the wikiskills paper again")).toBe(
      true,
    );
    expect(store.countDeferred("agent:main:main", "Please review the wikiskills paper again")).toBe(
      false,
    );
    expect(store.list()).toHaveLength(before + 1);
  });
});
