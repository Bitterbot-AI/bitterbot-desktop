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
import {
  contentWords,
  fallbackTaskSlug,
  MAX_PENDING_TYPES,
  overlapCoefficient,
  parseTaskLabelResponse,
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
