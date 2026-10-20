/**
 * PLAN-55 Phase 2, consumer 5: open anticipation briefs and task plans that
 * cite the old value are flagged stale_fact and surfaced as a question.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../tasks/store.js";
import { readTaskStaleFacts } from "../tasks/types.js";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { propagateToBriefsAndTasks } from "./canonical-supersede-briefs.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

let db: DatabaseSync;
let tasks: TaskStore;
let directives: EpistemicDirectiveEngine;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  tasks = new TaskStore(new DatabaseSync(":memory:"));
  directives = new EpistemicDirectiveEngine(db);
});

function brief(id: string, question: string, answer: string, status = "open"): void {
  db.prepare(
    `INSERT INTO dream_briefs (id, context_kind, question, answer_sketch, status, created_at)
     VALUES (?, 'active_context', ?, ?, ?, 1)`,
  ).run(id, question, answer, status);
}

const briefRow = (id: string) =>
  db.prepare(`SELECT status, stale_fact FROM dream_briefs WHERE id = ?`).get(id) as {
    status: string;
    stale_fact: string | null;
  };

const event = (over: Partial<CanonicalChangeEvent>): CanonicalChangeEvent => ({
  key: "infra.deploy_endpoint",
  oldValue: "api.acme.com",
  newValue: "api2.acme.com",
  op: "supersede",
  tier: 3,
  source: "owner",
  scope: "global",
  evidence: { ref: null, chunkIds: [] },
  factId: "fact-2",
  at: 1_000,
  ...over,
});

const run = (e: CanonicalChangeEvent) =>
  propagateToBriefsAndTasks({ db, event: e, taskStore: tasks, directives });

describe("brief and task propagation", () => {
  it("flags open briefs citing the old value and leaves the rest", async () => {
    brief("b1", "Where do we deploy?", "To api.acme.com, as usual.");
    brief("b2", "What is for lunch?", "Tacos.");
    brief("b3", "Deploy target?", "api.acme.com", "surfaced");
    const r = await run(event({}));
    expect(r.briefsFlagged).toBe(1);
    expect(briefRow("b1").status).toBe("stale_fact");
    expect(JSON.parse(briefRow("b1").stale_fact!)).toEqual([
      expect.objectContaining({
        key: "infra.deploy_endpoint",
        oldValue: "api.acme.com",
        newValue: "api2.acme.com",
        factId: "fact-2",
      }),
    ]);
    expect(briefRow("b2")).toEqual({ status: "open", stale_fact: null });
    expect(briefRow("b3").status).toBe("surfaced");
  });

  it("flags open tasks whose plan or latest handoff cites the old value; task metadata keeps the rest", async () => {
    const viaPlan = tasks.create({
      goal: "Ship the release",
      doneCriteria: "deployed",
      plan: { steps: [{ id: "s1", title: "Deploy to api.acme.com", status: "pending" }] },
      metadata: { topic: "release" },
    });
    const viaHandoff = tasks.create({ goal: "Rotate keys", doneCriteria: "rotated" });
    tasks.writeHandoff({
      taskId: viaHandoff.id,
      intent: "paused",
      decisions: ["use api.acme.com as the callback endpoint"],
      pending: [],
    });
    const unrelated = tasks.create({ goal: "Write docs", doneCriteria: "written" });
    const done = tasks.create({ goal: "Old deploy to api.acme.com", doneCriteria: "x" });
    tasks.update(done.id, { status: "stopped" });
    const lastSeen = tasks.get(viaPlan.id)!.lastSeenAt;

    const r = await run(event({}));
    expect(r.tasksFlagged).toBe(2);
    const flags = readTaskStaleFacts(tasks.get(viaPlan.id)!);
    expect(flags).toEqual([
      {
        key: "infra.deploy_endpoint",
        oldValue: "api.acme.com",
        newValue: "api2.acme.com",
        factId: "fact-2",
        flaggedAt: 1_000,
      },
    ]);
    expect(tasks.get(viaPlan.id)!.metadata).toMatchObject({ topic: "release" });
    expect(tasks.get(viaPlan.id)!.lastSeenAt).toBe(lastSeen);
    expect(readTaskStaleFacts(tasks.get(viaHandoff.id)!)).toHaveLength(1);
    expect(readTaskStaleFacts(tasks.get(unrelated.id)!)).toEqual([]);
    expect(readTaskStaleFacts(tasks.get(done.id)!)).toEqual([]);

    // Idempotent.
    expect((await run(event({}))).tasksFlagged).toBe(0);
    expect(readTaskStaleFacts(tasks.get(viaPlan.id)!)).toHaveLength(1);
  });

  it("surfaces one stale_reference question naming the change and the tasks", async () => {
    tasks.create({ goal: "Ship the release to the api.acme.com endpoint", doneCriteria: "done" });
    const r = await run(event({}));
    expect(r.directiveId).not.toBeNull();
    const open = directives.listOpenDirectives(10);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ directiveType: "stale_reference" });
    expect(open[0]!.question).toContain(
      'Your correction: you changed infra.deploy_endpoint from "api.acme.com" to "api2.acme.com"',
    );
    expect(open[0]!.question).toContain(
      'If you say yes I will rewrite them to use "api2.acme.com"',
    );
    expect(open[0]!.question).toContain("Ship the release");
    expect(open[0]!.sourceEntityIds).toEqual(["stale_fact:infra.deploy_endpoint"]);
  });

  it("a pin back to the old value reopens briefs and clears task flags", async () => {
    brief("b1", "Where do we deploy?", "To api.acme.com.");
    const t = tasks.create({ goal: "Deploy to api.acme.com", doneCriteria: "done" });
    await run(event({}));
    const back = await run(
      event({ oldValue: "api2.acme.com", newValue: "api.acme.com", factId: "fact-3" }),
    );
    expect(back.briefsReopened).toBe(1);
    expect(back.tasksCleared).toBe(1);
    expect(briefRow("b1")).toEqual({ status: "open", stale_fact: null });
    expect(tasks.get(t.id)!.metadata?.staleFacts).toBeUndefined();
  });

  it("does nothing for soft retires or without a task store", async () => {
    brief("b1", "Which deploy endpoint?", "api.acme.com");
    await run(event({ op: "retire", newValue: null, retireReason: "agent" }));
    expect(briefRow("b1").status).toBe("open");
    const r = await propagateToBriefsAndTasks({
      db,
      event: event({}),
      taskStore: null,
      directives: null,
    });
    expect(r).toMatchObject({ briefsFlagged: 1, tasksFlagged: 0, directiveId: null });
  });

  it("flags per key: a brief citing two corrected keys reopens only when both come back", async () => {
    brief(
      "b1",
      "Deploy plan?",
      "Deploy endpoint api.acme.com, region eu-west-1 for the deploy region.",
    );
    const region = event({
      key: "infra.deploy_region",
      oldValue: "eu-west-1",
      newValue: "us-east-1",
      factId: "r2",
    });
    await run(event({}));
    await run(region);
    expect(JSON.parse(briefRow("b1").stale_fact!).map((n: { key: string }) => n.key)).toEqual([
      "infra.deploy_endpoint",
      "infra.deploy_region",
    ]);
    await run(event({ oldValue: "api2.acme.com", newValue: "api.acme.com", factId: "f3" }));
    expect(briefRow("b1").status).toBe("stale_fact");
    await run({ ...region, oldValue: "us-east-1", newValue: "eu-west-1", factId: "r3" });
    expect(briefRow("b1")).toEqual({ status: "open", stale_fact: null });
  });

  it("does not flag a task that names the value without the key's subject", async () => {
    const t = tasks.create({ goal: "Email ops@api.acme.com about lunch", doneCriteria: "sent" });
    expect((await run(event({}))).tasksFlagged).toBe(0);
    expect(readTaskStaleFacts(tasks.get(t.id)!)).toEqual([]);
  });

  it("skips tasks for a project-scoped change", async () => {
    const t = tasks.create({ goal: "Deploy to api.acme.com", doneCriteria: "done" });
    const r = await propagateToBriefsAndTasks({
      db,
      event: event({ scope: "project:acme" }),
      taskStore: tasks,
      directives,
      includeTasks: false,
    });
    expect(r.tasksFlagged).toBe(0);
    expect(readTaskStaleFacts(tasks.get(t.id)!)).toEqual([]);
  });
});
