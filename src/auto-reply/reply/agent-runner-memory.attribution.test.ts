/**
 * PLAN-64 Phase 3: the use-time attribution line, end to end over the two
 * real halves of a turn: the prompt path (buildPracticesBlock writes the
 * `applied` events) and the run-completion hook (runCorrectionCaptureAfterTurn
 * returns the line to append).
 *
 * Under test: the first two real-match applications show the line and the
 * third does not; the conditional fallback and a global practice never show
 * it; a "Practice saved" or offer line on the same reply wins and the
 * attribution is not counted; an edit or a re-scope re-arms it once; the
 * count survives a restart (a database file reopened); the switch; who never
 * gets a line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPracticesBlock, type PracticesBlockManager } from "../../agents/practices-block.js";
import type { BitterbotConfig } from "../../config/config.js";
import { CanonicalFactsStore } from "../../memory/canonical-facts.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import {
  answerPracticeOffer,
  savePractice,
  setPracticeScope,
} from "../../memory/owner-controls.js";
import { FollowUpStateStore } from "../../memory/practice-followups.js";
import { PracticesStore } from "../../memory/practices.js";
import { TaskTypesStore } from "../../memory/task-types.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  getManager: vi.fn(),
  peekManager: vi.fn(),
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: (params: unknown) => state.getManager(params),
  peekMemorySearchManager: (params: unknown) => state.peekManager(params),
}));

import { runCorrectionCaptureAfterTurn } from "./agent-runner-memory.js";

const STATS = "How many clones did your repo get yesterday?";
const NPM = "Include npm downloads";
const LINE = `Applied: "${NPM}" for repo stats, from 12 Nov.`;
const SESSION_KEY = "agent:main:main";
const SESSION_FILE = "/nonexistent/session.jsonl";
const WORKSPACE = "/srv/agents/acme";
const SAVED_AT = Date.UTC(2026, 10, 12, 10, 0, 0);
const CFG: BitterbotConfig = { agents: { defaults: { userTimezone: "UTC" } } };

const llm = vi.fn();
let dir: string;
let dbFile: string;
let db: DatabaseSync;
let practices: PracticesStore;
let taskTypes: TaskTypesStore;
let followUpState: FollowUpStateStore;
let clock: number;
let runSeq = 0;

/** In memory by default; the restart test passes a file and reopens it. */
function openDb(file = ":memory:"): void {
  db = new DatabaseSync(file);
  if (file !== ":memory:") {
    // A test file needs no durability; with it the migrations take minutes here.
    db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;");
  }
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  practices = new PracticesStore(db);
  taskTypes = new TaskTypesStore(db);
  followUpState = new FollowUpStateStore(db);
  const facts = new CanonicalFactsStore(db);
  const manager = {
    canonicalFacts: () => facts,
    correctionLlmCall: () => llm,
    practices: () => practices,
    taskTypes: () => taskTypes,
    ownerSavePractice: async (input: Parameters<typeof savePractice>[2]) =>
      savePractice(db, practices, input),
    ownerSetPracticeScope: async (id: string, scope: string) =>
      setPracticeScope(db, practices, id, scope),
    resolveCaptureTaskType: (_key: string | undefined, text: string) => {
      const type = taskTypes.classify(text);
      return type ? { slug: type.slug, label: type.label } : null;
    },
    practiceFollowUpDeps: () => ({
      practices,
      taskTypes,
      state: followUpState,
      change: async <T>(_label: string, fn: () => T) => fn(),
      answerOffer: async (id: string, answer: "yes" | "no") =>
        answerPracticeOffer(db, practices, id, answer),
    }),
  };
  state.peekManager.mockResolvedValue({ manager, error: null });
  state.getManager.mockResolvedValue({ manager, error: null });
}

/** What the prompt path sees of the manager. */
function blockManager(): PracticesBlockManager {
  return {
    practices: () => practices,
    taskTypes: () => taskTypes,
    observeOwnerTurnTaskType: ({ text }) => {
      const type = taskTypes.classify(text);
      return type?.recurring ? { slug: type.slug, label: type.label } : null;
    },
  };
}

function followupRun(over: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "x",
    enqueuedAt: clock,
    run: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: SESSION_KEY,
      senderIsOwner: true,
      sessionFile: SESSION_FILE,
      workspaceDir: WORKSPACE,
      config: CFG,
      ...over,
    },
  } as unknown as FollowupRun;
}

type TurnOptions = {
  cfg?: BitterbotConfig;
  replyText?: string;
  chatType?: string;
  isHeartbeat?: boolean;
  run?: Partial<FollowupRun["run"]>;
};

/** One owner turn: prompt build, then the run-completion hook. */
async function turn(body: string, opts: TurnOptions = {}) {
  // Twenty minutes apart: outside the follow-up window, so a repeated request
  // is not sent to the follow-up check (which would be a model call).
  clock += 20 * 60_000;
  vi.setSystemTime(clock);
  const runStartedAt = clock;
  const cfg = opts.cfg ?? CFG;
  const block = buildPracticesBlock(blockManager(), {
    config: cfg,
    sessionKey: SESSION_KEY,
    senderIsOwner: true,
    promptMode: "full",
    workspaceDir: WORKSPACE,
    prompt: body,
    runId: `run-${++runSeq}`,
    sessionFile: SESSION_FILE,
  });
  clock += 1_000;
  vi.setSystemTime(clock);
  const line = await runCorrectionCaptureAfterTurn({
    cfg,
    followupRun: followupRun(opts.run),
    sessionKey: SESSION_KEY,
    commandBody: body,
    replyText: opts.replyText ?? "Yesterday the repo had 68 unique clones.",
    isHeartbeat: opts.isHeartbeat ?? false,
    chatType: opts.chatType ?? "direct",
    runStartedAt,
  });
  return { block, line };
}

const attributed = (id: string) => practices.events(id).filter((e) => e.kind === "attributed");

function saveNpm(scope = "task:repo-stats") {
  const res = practices.upsert({ statement: NPM, scope, source: "owner", now: SAVED_AT });
  if (!res.ok) {
    throw new Error(res.reason);
  }
  return res.practice;
}

function adoptRepoStats(): void {
  taskTypes.adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: [STATS],
    occurrences: 9,
    distinctDays: 5,
    firstSeen: 0,
    lastSeen: 0,
    recurring: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.UTC(2026, 10, 20, 9, 0, 0);
  vi.setSystemTime(clock);
  llm.mockReset();
  state.getManager.mockReset();
  state.peekManager.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-attribution-"));
  dbFile = path.join(dir, "memory.sqlite");
  openDb();
  adoptRepoStats();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("practice attribution line (PLAN-64 Phase 3)", () => {
  it("shows the line the first two times a task practice is applied, and not the third", async () => {
    const practice = saveNpm();
    const first = await turn(STATS);
    expect(first.block).toContain(`- [repo stats] ${NPM}`);
    expect(first.line).toBe(LINE);
    expect((await turn(STATS)).line).toBe(LINE);
    expect((await turn(STATS)).line).toBeNull();
    expect((await turn(STATS)).line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(2);
    // Prompt inclusion is still counted on every run.
    expect(practices.get(practice.id)?.appliedCount).toBe(4);
    // No model call anywhere on this path.
    expect(llm).not.toHaveBeenCalled();
    expect(state.getManager).not.toHaveBeenCalled();
  });

  it("never shows it for the conditional fallback lines", async () => {
    const practice = saveNpm();
    const { block, line } = await turn("can you check the latest numbers?");
    expect(block).toContain(`- When the request is about repo stats: ${NPM}`);
    expect(line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(0);
    expect(practices.get(practice.id)?.appliedCount).toBe(0);
    // The two showings are still available for a real match.
    expect((await turn(STATS)).line).toBe(LINE);
  });

  it("never shows it for a global practice", async () => {
    const practice = saveNpm("global");
    const { block, line } = await turn(STATS);
    expect(block).toContain(`- ${NPM}`);
    expect(line).toBeNull();
    expect(practices.get(practice.id)?.appliedCount).toBe(1);
    expect(attributed(practice.id)).toHaveLength(0);
  });

  it("a Practice saved line on the same reply wins, and the attribution is not counted", async () => {
    const practice = saveNpm();
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [],
        practices: [
          {
            statement: "Always give clones day by day in a table.",
            scope: "task",
            explicit: true,
          },
        ],
      }),
    );
    const body =
      "How many clones did your repo get yesterday? Always give clones day by day in a table.";
    const { block, line } = await turn(body);
    expect(block).toContain(NPM);
    expect(line).toContain("Practice saved for repo stats");
    expect(line).not.toContain("Applied:");
    expect(attributed(practice.id)).toHaveLength(0);
  });

  it("an offer line on the same reply wins, and the attribution is not counted", async () => {
    const practice = saveNpm();
    const candidate = practices.upsert({
      statement: "Include open pull requests",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
      eventDetail: { sighting: { sessionId: "s-a", day: "2026-11-1", explicit: false } },
    });
    if (!candidate.ok) {
      throw new Error(candidate.reason);
    }
    practices.addSighting(candidate.practice.id, {
      detail: { sighting: { sessionId: "s-b", day: "2026-11-2", explicit: false } },
    });
    const offered = await turn(STATS);
    expect(offered.line).toContain("Include it every time? (yes / no)");
    expect(offered.line).not.toContain("Applied:");
    expect(attributed(practice.id)).toHaveLength(0);
    // The next reply has no offer (one per conversation): the line is shown.
    expect((await turn(STATS)).line).toBe(LINE);
  });

  it("an edit re-arms the line once, and so does a re-scope", async () => {
    const practice = saveNpm();
    await turn(STATS);
    await turn(STATS);
    expect((await turn(STATS)).line).toBeNull();

    clock += 1_000;
    vi.setSystemTime(clock);
    expect(practices.editStatement(practice.id, "Include npm downloads per day").ok).toBe(true);
    expect((await turn(STATS)).line).toBe(
      'Applied: "Include npm downloads per day" for repo stats, from 12 Nov.',
    );
    expect((await turn(STATS)).line).toBeNull();

    clock += 1_000;
    vi.setSystemTime(clock);
    expect(practices.setScope(practice.id, "project:acme").ok).toBe(true);
    expect((await turn("what is on the agenda today?")).line).toBe(
      'Applied: "Include npm downloads per day" for project acme, from 12 Nov.',
    );
    expect((await turn("and tomorrow?")).line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(4);
  });

  it("the count of times shown survives a restart", async () => {
    // A database file, closed and reopened with fresh stores each time.
    db.close();
    openDb(dbFile);
    adoptRepoStats();
    const practice = saveNpm();
    expect((await turn(STATS)).line).toBe(LINE);
    db.close();
    openDb(dbFile);
    expect((await turn(STATS)).line).toBe(LINE);
    db.close();
    openDb(dbFile);
    expect((await turn(STATS)).line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(2);
  });

  it("memory.practices.attribution.enabled=false: no line and nothing counted", async () => {
    const practice = saveNpm();
    const cfg: BitterbotConfig = {
      ...CFG,
      memory: { practices: { attribution: { enabled: false } } },
    };
    const { block, line } = await turn(STATS, { cfg });
    expect(block).toContain(NPM);
    expect(line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(0);
    // Switched back on, the two showings are intact.
    expect((await turn(STATS)).line).toBe(LINE);
  });

  it("names the most specific practice and counts the rest, which stay unshown", async () => {
    const task = saveNpm();
    const project = practices.upsert({
      statement: "Keep answers under ten lines",
      scope: "project:acme",
      source: "owner",
      now: SAVED_AT,
    });
    if (!project.ok) {
      throw new Error(project.reason);
    }
    expect((await turn(STATS)).line).toBe(
      `Applied: "${NPM}" for repo stats, from 12 Nov, and 1 more.`,
    );
    expect(attributed(task.id)).toHaveLength(1);
    expect(attributed(project.practice.id)).toHaveLength(0);
    await turn(STATS);
    // The task practice is spent; the project practice is named now.
    expect((await turn(STATS)).line).toBe(
      'Applied: "Keep answers under ten lines" for project acme, from 12 Nov.',
    );
  });

  it("is never shown in a group, on a heartbeat, to a non-owner, or with no reply text", async () => {
    const practice = saveNpm();
    expect((await turn(STATS, { chatType: "group" })).line).toBeNull();
    expect((await turn(STATS, { isHeartbeat: true })).line).toBeNull();
    expect((await turn(STATS, { run: { senderIsOwner: false } })).line).toBeNull();
    expect((await turn(STATS, { replyText: "  " })).line).toBeNull();
    expect(attributed(practice.id)).toHaveLength(0);
  });

  it("still applies when correction capture is switched off (practices are still rendered)", async () => {
    saveNpm();
    const cfg: BitterbotConfig = { ...CFG, memory: { correction: { enabled: false } } };
    expect((await turn(STATS, { cfg })).line).toBe(LINE);
  });

  it("uses the date the owner confirmed a candidate, in the owner's timezone", async () => {
    const candidate = practices.upsert({
      statement: NPM,
      scope: "task:repo-stats",
      source: "extraction",
      now: Date.UTC(2026, 10, 3, 10, 0, 0),
    });
    if (!candidate.ok) {
      throw new Error(candidate.reason);
    }
    // 23:30 UTC on 14 Nov is already 15 Nov in Tokyo.
    practices.activate(candidate.practice.id, Date.UTC(2026, 10, 14, 23, 30, 0), "offer");
    const cfg: BitterbotConfig = { agents: { defaults: { userTimezone: "Asia/Tokyo" } } };
    expect((await turn(STATS, { cfg })).line).toBe(
      `Applied: "${NPM}" for repo stats, from 15 Nov.`,
    );
  });
});
