import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  inspectCronJobs,
  inspectTaskStore,
  parseCronJobs,
  pendingWakeupTaskIds,
} from "./doctor-tasks.js";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60_000;
const NONE: ReadonlySet<string> = new Set();

function taskDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, goal TEXT, done_criteria TEXT, status TEXT NOT NULL,
      source TEXT, created_at INTEGER, updated_at INTEGER, last_seen_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertTask(db: DatabaseSync, id: string, status: string, lastSeenAt: number): void {
  db.prepare(
    `INSERT INTO tasks (id, goal, done_criteria, status, source, created_at, updated_at, last_seen_at)
     VALUES (?, 'g', 'd', ?, 'agent', ?, ?, ?)`,
  ).run(id, status, NOW - DAY, NOW - DAY, lastSeenAt);
}

describe("inspectTaskStore", () => {
  it("warns on in-flight tasks not seen for over a day with no wakeup", () => {
    const db = taskDb();
    insertTask(db, "t1", "running", NOW - 2 * DAY); // orphaned
    insertTask(db, "t2", "running", NOW - 60_000); // fresh
    insertTask(db, "t3", "completed", NOW - 30 * DAY); // terminal, ignored
    const results = inspectTaskStore(db, NONE, NOW);
    expect(
      results.some((r) => r.level === "warn" && /1 in-flight task\(s\) not seen/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("does NOT warn on a stale task that has a pending wakeup (suspended by design)", () => {
    // The whole point of PLAN-16: park a task for days with a scheduled
    // resume. That is the system working, not an orphan.
    const db = taskDb();
    insertTask(db, "t1", "waiting_external", NOW - 3 * DAY);
    const results = inspectTaskStore(db, new Set(["t1"]), NOW);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
    expect(results.some((r) => /parked with a scheduled wakeup/.test(r.message))).toBe(true);
    db.close();
  });

  it("ok when nothing is stale", () => {
    const db = taskDb();
    insertTask(db, "t1", "running", NOW - 60_000);
    insertTask(db, "t2", "failed", NOW - 30 * DAY);
    const results = inspectTaskStore(db, NONE, NOW);
    expect(results.some((r) => r.level === "ok" && /none stale/.test(r.message))).toBe(true);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });
});

describe("parseCronJobs / pendingWakeupTaskIds", () => {
  it("extracts task ids from enabled wakeup jobs only", () => {
    const jobs = parseCronJobs(
      JSON.stringify({
        version: 1,
        jobs: [
          {
            jobId: "task-wakeup-t1-x",
            enabled: true,
            payload: { kind: "agentTurn", taskId: "t1" },
          },
          { jobId: "task-wakeup-t2-x", enabled: false, payload: { taskId: "t2" } },
          { jobId: "daily-report", enabled: true, payload: { kind: "agentTurn" } },
        ],
      }),
    );
    expect(jobs).not.toBeNull();
    const ids = pendingWakeupTaskIds(jobs ?? []);
    expect(ids.has("t1")).toBe(true);
    expect(ids.has("t2")).toBe(false); // disabled job resumes nothing
    expect(ids.size).toBe(1);
  });

  it("returns null on unparseable JSON", () => {
    expect(parseCronJobs("{nope")).toBeNull();
  });
});

describe("inspectCronJobs", () => {
  it("warns on overdue enabled jobs only while the gateway is running", () => {
    const jobs = [
      { jobId: "a", enabled: true, nextRunAt: NOW - 3 * 60 * 60_000 },
      { jobId: "b", enabled: false, nextRunAt: NOW - 3 * 60 * 60_000 },
    ];
    const running = inspectCronJobs(jobs, true, NOW);
    expect(running.some((r) => r.level === "warn" && /wedged/.test(r.message))).toBe(true);

    // Gateway down: an overdue job is expected, stay quiet.
    const stopped = inspectCronJobs(jobs, false, NOW);
    expect(stopped.every((r) => r.level !== "warn")).toBe(true);
  });

  it("does not warn inside the 2h slack (long in-flight runs, restart backlog)", () => {
    const jobs = [
      { jobId: "a", enabled: true, nextRunAt: NOW + 60_000 },
      { jobId: "b", enabled: true, nextRunAt: NOW - 90 * 60_000 }, // 1.5h overdue: inside slack
    ];
    const results = inspectCronJobs(jobs, true, NOW);
    expect(results.some((r) => r.level === "ok")).toBe(true);
    expect(results.every((r) => r.level !== "warn")).toBe(true);
  });

  it("warns per job with repeated consecutive failures", () => {
    const jobs = [{ jobId: "a", name: "wakeup-t1", enabled: true, consecutiveErrors: 5 }];
    const results = inspectCronJobs(jobs, false, NOW);
    expect(
      results.some((r) => r.level === "warn" && /wakeup-t1.*failed 5 times/.test(r.message)),
    ).toBe(true);
  });
});
