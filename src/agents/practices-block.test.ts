/**
 * PLAN-64 Phase 1: the Standing Practices prompt block.
 *
 * Under test: who gets the block (the owner's first-party turns; a cron
 * job's own session for its job-scoped practices only; nobody else), that
 * the turn's task type is resolved before the block is built, ordering
 * (most specific scope first), the practice cap and the token budget, the
 * scope tags, that only active practices render, the applied counter (one
 * per run, for rendered practices only), and the disabled switch.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { PracticesStore } from "../memory/practices.js";
import { observeOwnerTurn, TaskTypesStore } from "../memory/task-types.js";
import {
  buildPracticesBlock,
  cronJobIdFromSessionKey,
  PRACTICES_BLOCK_BUDGET_TOKENS,
  PRACTICES_BLOCK_HEADER,
  PRACTICES_BLOCK_MAX,
  PRACTICES_CONDITIONAL_MAX,
  type PracticesBlockManager,
  renderConditionalPracticeLines,
  renderPracticesBlock,
  resolvePracticesTurnPolicy,
} from "./practices-block.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

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

const OWNER_SESSION = "agent:main:main";
const DAY = 24 * 3_600_000;
const NPM = "Include npm downloads when reporting repo stats.";
const STATS_QUESTION =
  "[Fri 2026-11-27 09:14 EST] How did the repo do on clones and views yesterday?";

let practices: PracticesStore;
let taskTypes: TaskTypesStore;
let manager: PracticesBlockManager;

beforeEach(async () => {
  const db = makeDb();
  practices = new PracticesStore(db);
  taskTypes = new TaskTypesStore(db);
  manager = {
    practices: () => practices,
    taskTypes: () => taskTypes,
    // What MemoryIndexManager.observeOwnerTurnTaskType does, without a model.
    observeOwnerTurnTaskType: (params) => observeOwnerTurn(taskTypes, params, null),
  };
  // A recurring "repo stats" type, as three days of real questions make it.
  let pending = "";
  [
    "How many clones did your repo get yesterday?",
    "how did our npm's and clones do yesterday?",
    "Can you check npm, clones and views for yesterday for your repo?",
  ].forEach((text, i) => {
    pending = taskTypes.observe(text, { now: Date.now() - (5 - i) * DAY }).type!.slug;
  });
  await taskTypes.promote(pending, async () => '{"slug":"repo-stats","label":"repo stats"}');
});

const ownerTurn = (over: Record<string, unknown> = {}) => ({
  config: {},
  sessionKey: OWNER_SESSION,
  senderIsOwner: true,
  isHeartbeat: false,
  promptMode: "full" as const,
  prompt: STATS_QUESTION,
  runId: "run-1",
  ...over,
});

describe("resolvePracticesTurnPolicy", () => {
  it("owner first-party turns get every matching scope; a cron job session gets its job only", () => {
    expect(resolvePracticesTurnPolicy(ownerTurn())).toEqual({ kind: "owner" });
    expect(resolvePracticesTurnPolicy({ config: {}, sessionKey: "agent:main:cron:job-7" })).toEqual(
      {
        kind: "job",
        cronJobId: "job-7",
      },
    );
    expect(
      resolvePracticesTurnPolicy({ config: {}, sessionKey: "agent:main:cron:job-7:run:r1" }),
    ).toEqual({ kind: "job", cronJobId: "job-7" });
  });

  it("guests, groups, subagents, heartbeats, non-owners and promptMode none get nothing", () => {
    for (const over of [
      { senderIsOwner: false },
      { senderIsOwner: undefined },
      { guestTurn: true },
      { isHeartbeat: true },
      { promptMode: "none" },
      { sessionKey: undefined },
      { sessionKey: "agent:main:subagent:abc" },
      { sessionKey: "agent:main:telegram:group:123" },
      { config: { memory: { practices: { enabled: false } } } },
    ]) {
      expect(resolvePracticesTurnPolicy(ownerTurn(over)), JSON.stringify(over)).toBeNull();
    }
    // A heartbeat inside a cron session gets nothing either.
    expect(
      resolvePracticesTurnPolicy({
        config: {},
        sessionKey: "agent:main:cron:j",
        isHeartbeat: true,
      }),
    ).toBeNull();
  });

  it("reads the job id from a cron session key only", () => {
    expect(cronJobIdFromSessionKey("cron:abc")).toBe("abc");
    expect(cronJobIdFromSessionKey("agent:main:cron:abc")).toBe("abc");
    expect(cronJobIdFromSessionKey("agent:main:cron:abc:run:r9")).toBe("abc");
    expect(cronJobIdFromSessionKey("agent:main:main")).toBeNull();
    expect(cronJobIdFromSessionKey("agent:main:cron:abc:other:x")).toBeNull();
    expect(cronJobIdFromSessionKey(undefined)).toBeNull();
  });
});

describe("buildPracticesBlock", () => {
  beforeEach(() => {
    practices.upsert({
      statement: "Keep answers short.",
      scope: "global",
      source: "owner",
      now: 1,
    });
    practices.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner", now: 2 });
    practices.upsert({
      statement: "Use British spelling.",
      scope: "project:acme",
      source: "owner",
      now: 3,
    });
    practices.upsert({
      statement: "Send the digest as a table.",
      scope: "job:job-7",
      source: "owner",
      now: 4,
    });
    practices.upsert({
      statement: "Cc her manager on invoices.",
      scope: "person:alice",
      source: "owner",
      now: 5,
    });
    practices.upsert({
      statement: "Mention open pull requests too.",
      scope: "task:repo-stats",
      source: "extraction",
      now: 6,
    });
  });

  it("types the turn first, then renders the matching active practices, most specific first", () => {
    const block = buildPracticesBlock(
      manager,
      ownerTurn({ workspaceDir: "/home/v/projects/Acme" }),
    );
    expect(block).toBe(
      [
        ...PRACTICES_BLOCK_HEADER,
        `- [repo stats] ${NPM}`,
        "- [project acme] Use British spelling.",
        "- [for alice] Cc her manager on invoices.",
        "- Keep answers short.",
      ].join("\n"),
    );
    // The candidate and the job practice are not there.
    expect(block).not.toContain("pull requests");
    expect(block).not.toContain("digest");
  });

  it("a turn that matched no task type gets the task practice as a condition, uncounted", () => {
    const block = buildPracticesBlock(
      manager,
      ownerTurn({ prompt: "Can you make me a cool fireworks display", runId: "run-2" }),
    );
    // Not as a matched practice: no [repo stats] tag.
    expect(block).not.toContain(`- [repo stats] ${NPM}`);
    // As a condition the answering model can judge.
    expect(block).toContain(`- When the request is about repo stats: ${NPM}`);
    expect(block).toContain("- Keep answers short.");
    expect(block).not.toContain("Use British spelling.");
    // The candidate is never shown, conditionally or otherwise.
    expect(block).not.toContain("pull requests");
    // Inclusion as a condition is not "applied".
    const npm = practices.list({ statuses: ["active"] }).find((p) => p.statement === NPM);
    expect(npm?.appliedCount).toBe(0);
  });

  it("the real miss: a vague stats request still carries the stats practice", () => {
    const block = buildPracticesBlock(
      manager,
      ownerTurn({
        prompt: "[Fri 2026-11-27 11:36 EST] Can you check the latest stats?",
        runId: "run-3",
      }),
    );
    expect(block).toContain(`- When the request is about repo stats: ${NPM}`);
  });

  it("a matched turn gets no conditional lines", () => {
    const block = buildPracticesBlock(manager, ownerTurn({ runId: "run-4" }));
    expect(block).not.toContain("When the request is about");
  });

  it("caps conditional lines and renders them even when nothing else is visible", () => {
    const db = makeDb();
    const onlyTask = new PracticesStore(db);
    const types = new TaskTypesStore(db);
    for (let i = 0; i < PRACTICES_CONDITIONAL_MAX + 2; i++) {
      onlyTask.upsert({
        statement: `Distinct instruction number ${i} about zebras${"!".repeat(i)}`,
        scope: "task:repo-stats",
        source: "owner",
        now: i + 1,
      });
    }
    const lines = renderConditionalPracticeLines(
      {
        practices: () => onlyTask,
        taskTypes: () => ({
          list: () => [{ slug: "repo-stats", label: "repo stats", occurrences: 9 }],
        }),
      },
      10_000,
    );
    expect(lines.length).toBeLessThanOrEqual(PRACTICES_CONDITIONAL_MAX);
    expect(lines.length).toBeGreaterThan(0);
    void types;
    // A task type that is not recurring gives no label to condition on.
    expect(
      renderConditionalPracticeLines(
        { practices: () => onlyTask, taskTypes: () => ({ list: () => [] }) },
        10_000,
      ),
    ).toEqual([]);
    // No room, no lines.
    expect(
      renderConditionalPracticeLines(
        {
          practices: () => onlyTask,
          taskTypes: () => ({
            list: () => [{ slug: "repo-stats", label: "repo stats", occurrences: 9 }],
          }),
        },
        10,
      ),
    ).toEqual([]);
  });

  it("a cron job session gets no conditional lines", () => {
    const block = buildPracticesBlock(manager, {
      ...ownerTurn({ prompt: "[cron] daily digest", runId: "run-5" }),
      sessionKey: "cron:job-7",
    });
    expect(block ?? "").not.toContain("When the request is about");
  });

  it("a cron job's own session gets its job practices only, and never types the prompt", () => {
    const before = taskTypes.list().length;
    const block = buildPracticesBlock(manager, {
      config: {},
      sessionKey: "agent:main:cron:job-7",
      promptMode: "minimal",
      prompt: "How did the repo do on clones and views yesterday?",
      runId: "cron-run-1",
    });
    expect(block).toBe(
      [...PRACTICES_BLOCK_HEADER, "- [this job] Send the digest as a table."].join("\n"),
    );
    expect(taskTypes.list()).toHaveLength(before);
    expect(taskTypes.get("repo-stats")?.occurrences).toBe(3);
    // Another job's session gets nothing.
    expect(
      buildPracticesBlock(manager, { config: {}, sessionKey: "agent:main:cron:job-8" }),
    ).toBeUndefined();
  });

  it("returns nothing, counts nothing and types nothing for a turn that is not the owner's", () => {
    for (const over of [
      { senderIsOwner: false },
      { guestTurn: true },
      { isHeartbeat: true },
      { sessionKey: "agent:main:subagent:abc" },
      { sessionKey: "agent:main:telegram:group:123" },
      { config: { memory: { practices: { enabled: false } } } },
    ]) {
      expect(buildPracticesBlock(manager, ownerTurn(over)), JSON.stringify(over)).toBeUndefined();
    }
    expect(practices.list().every((p) => p.appliedCount === 0)).toBe(true);
    expect(taskTypes.get("repo-stats")?.occurrences).toBe(3);
  });

  it("records prompt inclusion once per run, for the rendered practices only", () => {
    buildPracticesBlock(manager, ownerTurn({ sessionFile: "/s/a.jsonl" }));
    // A retried attempt of the same run.
    buildPracticesBlock(manager, ownerTurn({ sessionFile: "/s/a.jsonl" }));
    const byScope = new Map(practices.list().map((p) => [p.scope + p.status, p]));
    expect(byScope.get("task:repo-statsactive")?.appliedCount).toBe(1);
    expect(byScope.get("globalactive")?.appliedCount).toBe(1);
    expect(byScope.get("project:acmeactive")?.appliedCount).toBe(0);
    expect(byScope.get("job:job-7active")?.appliedCount).toBe(0);
    expect(byScope.get("task:repo-statscandidate")?.appliedCount).toBe(0);
    const task = byScope.get("task:repo-statsactive")!;
    expect(practices.events(task.id).filter((e) => e.kind === "applied")).toMatchObject([
      { sessionRef: "session:/s/a.jsonl", detail: { via: "prompt" } },
    ]);
    // The turn was counted as one occurrence of its type, not two.
    expect(taskTypes.get("repo-stats")?.occurrences).toBe(4);
    // The next run counts again.
    buildPracticesBlock(manager, ownerTurn({ runId: "run-9" }));
    expect(practices.get(task.id)?.appliedCount).toBe(2);
  });
});

describe("renderPracticesBlock budget", () => {
  const make = (n: number, statement: (i: number) => string, scope = "global") => {
    const store = new PracticesStore(makeDb());
    for (let i = 0; i < n; i++) {
      store.upsert({ statement: statement(i), scope, source: "owner", now: i });
    }
    return store;
  };

  it("caps at eight practices", () => {
    const store = make(12, (i) => `Practice number ${i} about topic${i} widget${i} gadget${i}.`);
    const { block, rendered } = renderPracticesBlock(store.listVisible({}));
    expect(rendered).toHaveLength(PRACTICES_BLOCK_MAX);
    expect(block!.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
  });

  it("stays within about 400 tokens, dropping the least specific first", () => {
    const store = make(
      6,
      (i) =>
        `Long practice ${i} alpha${i} beta${i} gamma${i} ${"padding words here ".repeat(13)}end${i}.`,
    );
    store.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner" });
    const { block, rendered } = renderPracticesBlock(store.listVisible({ taskSlug: "repo-stats" }));
    expect(block!.length).toBeLessThanOrEqual(PRACTICES_BLOCK_BUDGET_TOKENS * 4);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(7);
    // The task practice is first and survives.
    expect(rendered[0]!.scope).toBe("task:repo-stats");
  });

  it("renders nothing for no practices", () => {
    expect(renderPracticesBlock([])).toEqual({ block: undefined, rendered: [] });
  });
});

describe("the practices block in the system prompt", () => {
  const BLOCK = [...PRACTICES_BLOCK_HEADER, `- [repo stats] ${NPM}`].join("\n");

  it("renders below the cache boundary, in full and minimal mode, never for a guest", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      practices: BLOCK,
      canonicalFacts: "## Canonical Facts\n- [k] v",
    });
    expect(prompt).toContain(BLOCK);
    // Turn-dependent: it must sit after the facts block and after the boundary.
    expect(prompt.indexOf("## Standing Practices")).toBeGreaterThan(
      prompt.indexOf("## Canonical Facts"),
    );
    const boundary = prompt.indexOf("BITTERBOT_CACHE_BOUNDARY");
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.indexOf("## Standing Practices")).toBeGreaterThan(boundary);
    // The cached half is identical with and without the block.
    const without = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      canonicalFacts: "## Canonical Facts\n- [k] v",
    });
    expect(prompt.slice(0, boundary)).toBe(
      without.slice(0, without.indexOf("BITTERBOT_CACHE_BOUNDARY")),
    );

    expect(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/bitterbot",
        promptMode: "minimal",
        practices: BLOCK,
      }),
    ).toContain("## Standing Practices");
    expect(
      buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot", practices: BLOCK, guestTurn: true }),
    ).not.toContain("## Standing Practices");
    expect(buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot" })).not.toContain(
      "## Standing Practices",
    );
  });
});
