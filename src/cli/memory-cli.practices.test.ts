/**
 * PLAN-64 Phase 1b: `bitterbot memory practices list | backfill | merge-types`.
 *
 * Under test, with the real stores on an in-memory database and transcripts
 * written to a temp directory: the list prints statuses and counters, the
 * backfill shows its counts and call budget before it runs, is a dry run
 * unless `--apply` is given, and `--apply` stores candidates only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const sessionsDir = vi.hoisted(() => ({ path: "" }));

vi.mock("../memory/index.js", () => ({ getMemorySearchManager }));
vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../agents/agent-scope.js", () => ({ resolveDefaultAgentId: () => "main" }));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => sessionsDir.path,
}));

import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { mergeTaskTypes } from "../memory/owner-controls.js";
import { PracticesStore } from "../memory/practices.js";
import { TaskTypesStore } from "../memory/task-types.js";

const STATS = "How many clones did your repo get yesterday?";

function transcript(day: number, followUp: string): string {
  const d = String(day).padStart(2, "0");
  const msg = (role: string, text: string, at: string) =>
    JSON.stringify({
      type: "message",
      timestamp: at,
      message: { role, content: [{ type: "text", text }] },
    });
  return [
    msg("user", STATS, `2026-11-${d}T14:00:00.000Z`),
    msg("assistant", "68 unique clones yesterday.", `2026-11-${d}T14:00:20.000Z`),
    msg("user", followUp, `2026-11-${d}T14:02:00.000Z`),
  ].join("\n");
}

let db: DatabaseSync;
let practices: PracticesStore;
let taskTypes: TaskTypesStore;
const llm = vi.fn<(prompt: string) => Promise<string>>();

function manager() {
  return {
    practices: () => practices,
    taskTypes: () => taskTypes,
    practiceCounters: () => practices.counters(),
    practiceFollowUpDeps: () => ({ change: async <T>(_label: string, fn: () => T) => fn() }),
    correctionLlmCall: () => llm,
    ownerMergeTaskTypes: async (from: string, into: string) =>
      mergeTaskTypes(db, taskTypes, from, into),
    close: vi.fn(async () => {}),
  };
}

async function run(args: string[]) {
  const { registerMemoryCli } = await import("./memory-cli.js");
  const { defaultRuntime } = await import("../runtime.js");
  getMemorySearchManager.mockResolvedValueOnce({ manager: manager() });
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  // A second run in one test spies on the same functions: start clean.
  log.mockClear();
  error.mockClear();
  const program = new Command();
  program.name("test");
  registerMemoryCli(program);
  await program.parseAsync(["memory", "practices", ...args], { from: "user" });
  return {
    lines: log.mock.calls.map((c) => String(c[0])),
    out: log.mock.calls.map((c) => String(c[0])).join("\n"),
    err: error.mock.calls.map((c) => String(c[0])).join("\n"),
  };
}

beforeEach(() => {
  sessionsDir.path = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cli-practices-"));
  fs.writeFileSync(
    path.join(sessionsDir.path, "a.jsonl"),
    transcript(7, "how about our npm downloads"),
  );
  fs.writeFileSync(
    path.join(sessionsDir.path, "b.jsonl"),
    transcript(8, "how about our npm downloads"),
  );
  fs.writeFileSync(
    path.join(sessionsDir.path, "c.jsonl.deleted.2026-11-09"),
    transcript(9, "how about our npm downloads"),
  );
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  practices = new PracticesStore(db);
  taskTypes = new TaskTypesStore(db, {
    onMerge: (from, into) => practices.repointTaskScope(from, into),
  });
  taskTypes.adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: [STATS],
    occurrences: 3,
    distinctDays: 3,
    firstSeen: 1,
    lastSeen: 2,
    recurring: true,
  });
  llm.mockReset();
  llm.mockResolvedValue('{"kind":"gap","missing":"Include npm downloads"}');
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  process.exitCode = undefined;
  db.close();
  fs.rmSync(sessionsDir.path, { recursive: true, force: true });
});

describe("memory practices backfill", () => {
  it("shows the counts and the call budget first, then the candidates; a dry run writes nothing", async () => {
    const { lines, out, err } = await run(["backfill"]);
    expect(err).toBe("");
    // Deleted transcripts are not read: two conversations, two follow-ups.
    expect(lines[0]).toBe(
      "Read 2 conversation(s), 4 message(s) of yours. 2 follow-up(s) to a recurring request to examine, 0 task type(s) to name.",
    );
    expect(lines[1]).toBe("Making at most 40 model call(s) (--max-calls).");
    expect(out).toContain("Model calls: 2 of at most 40.");
    expect(out).toContain(
      "[repo stats] Include npm downloads (new; 2 independent sighting(s); will be offered)",
    );
    expect(out).toContain('"how about our npm downloads"');
    expect(out).toContain("Dry run: nothing was written. Re-run with --apply");
    expect(practices.list()).toEqual([]);
    expect(out).not.toContain("—");
  });

  it("--apply stores candidates, never active practices", async () => {
    const { out } = await run(["backfill", "--apply"]);
    expect(out).toContain("Written: 1 new candidate(s), 2 sighting(s), 0 task type(s).");
    expect(practices.list()).toMatchObject([
      { statement: "Include npm downloads", status: "candidate", origin: "backfill" },
    ]);
    expect(practices.listVisible({ taskSlug: "repo-stats" })).toEqual([]);
  });

  it("--max-calls bounds the calls and is validated", async () => {
    const limited = await run(["backfill", "--max-calls", "1"]);
    expect(limited.lines[1]).toBe("Making at most 1 model call(s) (--max-calls).");
    expect(llm).toHaveBeenCalledTimes(1);
    expect(limited.out).toContain("Follow-ups not examined: 1.");
    const bad = await run(["backfill", "--max-calls", "lots"]);
    expect(bad.err).toContain("--max-calls must be a number");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("--json prints the result object only", async () => {
    const { lines } = await run(["backfill", "--json"]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      followUps: 2,
      modelCalls: 2,
      applied: null,
      candidates: [{ statement: "Include npm downloads", sightings: 2 }],
    });
  });
});

describe("memory practices list and merge-types", () => {
  it("lists practices with status, scope and counters", async () => {
    const saved = practices.upsert({
      statement: "Give the numbers first.",
      scope: "task:repo-stats",
      source: "owner",
    });
    if (!saved.ok) {
      throw new Error("seed failed");
    }
    practices.recordApplied([saved.practice.id], { turnKey: "r1" });
    practices.upsert({ statement: "Include npm downloads.", source: "extraction" });
    const { out } = await run(["list"]);
    expect(out).toContain("active");
    expect(out).toContain("task:repo-stats");
    expect(out).toContain("Give the numbers first.");
    expect(out).toContain("candidate");
    expect(out).toContain("Totals: applied 1, repeats 0, offers 0 (0 confirmed, 0 declined).");
    expect(out).toContain("Recurring task types: repo-stats (3)");
    const onlyCandidates = await run(["list", "--status", "candidate"]);
    expect(onlyCandidates.out).not.toContain("Give the numbers first.");
    const bad = await run(["list", "--status", "bogus"]);
    expect(bad.err).toContain('Unknown status "bogus"');
    const json = await run(["list", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({
      counters: { applied: 1 },
      taskTypes: [{ slug: "repo-stats" }],
    });
  });

  it("merge-types folds one task type into another", async () => {
    taskTypes.adopt({
      slug: "npm-download-clone",
      label: "npm downloads",
      exemplars: ["how about our npm downloads"],
      occurrences: 3,
      distinctDays: 3,
      firstSeen: 1,
      lastSeen: 2,
      recurring: true,
    });
    const ok = await run(["merge-types", "npm-download-clone", "repo-stats"]);
    expect(ok.out).toBe("Merged npm-download-clone into repo-stats (6 request(s)).");
    expect(taskTypes.get("npm-download-clone")).toBeNull();
    const missing = await run(["merge-types", "nope", "repo-stats"]);
    expect(missing.err).toContain("no task type named nope");
    expect(process.exitCode).toBe(1);
  });
});
