/**
 * PLAN-64 Phase 3: the "What I learned from you" section of the daily owner
 * brief. Under test: each of its four parts (saved or confirmed, waiting
 * for a yes or no, no longer repeated, repeated), the window, that the
 * section is left out when there is nothing to say, and what makes the
 * brief worth sending.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { briefIsWorthSending, buildDreamBrief, renderDreamBrief } from "./dream-brief.js";
import { ensureDreamSchema } from "./dream-schema.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  buildPracticeDigest,
  practiceDigestHasNews,
  practiceDigestIsEmpty,
  renderPracticeDigest,
} from "./practice-digest.js";
import { PracticesStore } from "./practices.js";
import { TaskTypesStore } from "./task-types.js";
import { UserModelManager } from "./user-model.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const since = now - DAY;
const SECTION = "What I learned from you:";

let db: DatabaseSync;
let store: PracticesStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureDreamSchema(db);
  new UserModelManager(db);
  store = new PracticesStore(db);
  new TaskTypesStore(db).adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: ["How many clones did your repo get yesterday?"],
    occurrences: 5,
    distinctDays: 4,
    firstSeen: 0,
    lastSeen: 0,
    recurring: true,
  });
});

function save(
  statement: string,
  opts: { scope?: string; source?: "owner" | "extraction"; at: number },
) {
  const res = store.upsert({
    statement,
    scope: opts.scope ?? "task:repo-stats",
    source: opts.source ?? "owner",
    now: opts.at,
  });
  if (!res.ok) {
    throw new Error(res.reason);
  }
  return res.practice;
}

describe("buildPracticeDigest", () => {
  it("is empty with no practices, and the brief has no such section", () => {
    const digest = buildPracticeDigest(db, since);
    expect(practiceDigestIsEmpty(digest)).toBe(true);
    expect(renderPracticeDigest(digest)).toEqual([]);
    const brief = buildDreamBrief(db, since);
    expect(briefIsWorthSending(brief)).toBe(false);
    expect(renderDreamBrief(brief)).not.toContain(SECTION);
  });

  it("is empty on a database without the practices tables", () => {
    const bare = new DatabaseSync(":memory:");
    expect(practiceDigestIsEmpty(buildPracticeDigest(bare, since))).toBe(true);
  });

  it("lists practices saved since the last brief, with the task label, and not older ones", () => {
    save("Include npm downloads", { at: now - 1000 });
    save("Keep answers under ten lines", { scope: "global", at: now - 3 * DAY });
    const digest = buildPracticeDigest(db, since);
    expect(digest.saved).toEqual([{ statement: "Include npm downloads", where: "repo stats" }]);
    expect(practiceDigestHasNews(digest)).toBe(true);
    const brief = buildDreamBrief(db, since);
    // A saved practice is news even on a night without dreams.
    expect(briefIsWorthSending(brief)).toBe(true);
    const text = renderDreamBrief(brief);
    expect(text).toContain(SECTION);
    expect(text).toContain('- Saved for repo stats: "Include npm downloads"');
    expect(text).not.toContain("Keep answers under ten lines");
    expect(text).not.toContain("—");
  });

  it("lists a candidate the owner said yes to as saved on the day of the yes", () => {
    const candidate = save("Include open pull requests", {
      source: "extraction",
      at: now - 5 * DAY,
    });
    expect(buildPracticeDigest(db, since).saved).toEqual([]);
    store.activate(candidate.id, now - 2000, "offer");
    expect(buildPracticeDigest(db, since).saved).toEqual([
      { statement: "Include open pull requests", where: "repo stats" },
    ]);
  });

  it("lists candidates that were offered and not answered, and never an unoffered one", () => {
    const offered = save("Include open pull requests", { source: "extraction", at: now - 5 * DAY });
    save("Mention the star count as well", { source: "extraction", at: now - 5 * DAY });
    store.recordOffer(offered.id, { sessionId: "s1", now: now - 4 * DAY });
    const digest = buildPracticeDigest(db, since);
    expect(digest.awaiting).toEqual([
      { statement: "Include open pull requests", where: "repo stats" },
    ]);
    // Standing state alone does not cause a brief, but it is rendered in one.
    expect(practiceDigestHasNews(digest)).toBe(false);
    expect(briefIsWorthSending(buildDreamBrief(db, since))).toBe(false);
    expect(renderPracticeDigest(digest)).toEqual([
      SECTION,
      '- Waiting for your yes or no, for repo stats: "Include open pull requests" (answer on the Memory page)',
    ]);
    // Declined: no longer waiting.
    store.suppress(offered.id, now);
    expect(buildPracticeDigest(db, since).awaiting).toEqual([]);
  });

  it("lists practices applied since the last brief that were never repeated", () => {
    const npm = save("Include npm downloads", { at: now - 9 * DAY });
    const stale = save("Keep answers under ten lines", { scope: "global", at: now - 9 * DAY });
    store.recordApplied([npm.id, stale.id], { now: now - 3 * DAY });
    store.recordApplied([npm.id], { now: now - 2 * DAY });
    store.recordApplied([npm.id], { now: now - 1000 });
    const digest = buildPracticeDigest(db, since);
    // The global one was not in a prompt inside the window.
    expect(digest.noRepeat).toEqual([
      { statement: "Include npm downloads", where: "repo stats", applied: 3 },
    ]);
    expect(digest.repeats).toEqual([]);
    expect(renderPracticeDigest(digest)).toEqual([
      SECTION,
      "- Things you no longer have to repeat:",
      '  - "Include npm downloads" for repo stats: in my instructions 3 times, and you have not had to say it again',
    ]);
  });

  it("reports a repeat, and a repeated practice is not listed as no longer repeated", () => {
    const npm = save("Include npm downloads", { at: now - 9 * DAY });
    store.recordApplied([npm.id], { now: now - 2000 });
    store.recordRepeat(npm.id, { via: "follow_up", now: now - 1000 });
    store.recordRepeat(npm.id, { via: "correction", now: now - 500 });
    const digest = buildPracticeDigest(db, since);
    expect(digest.noRepeat).toEqual([]);
    expect(digest.repeats).toEqual([
      { statement: "Include npm downloads", where: "repo stats", times: 2 },
    ]);
    expect(practiceDigestHasNews(digest)).toBe(true);
    const text = renderDreamBrief(buildDreamBrief(db, since));
    expect(text).toContain(
      '- You had to tell me again, twice, for repo stats: "Include npm downloads". I counted it and changed nothing; you can reword or re-scope it on the Memory page.',
    );
    // A repeat before the window is not reported again.
    expect(buildPracticeDigest(db, now + 1).repeats).toEqual([]);
  });
});
