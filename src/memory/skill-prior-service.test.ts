import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillPriorLedger } from "../agents/skills/skill-prior.js";
import type { BitterbotConfig } from "../config/config.js";
import { BitterbotSchema } from "../config/zod-schema.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { EventJournal } from "../infra/event-journal.js";
import { appendRunFeedback } from "./skill-evolution/run-feedback.js";
import { SkillPriorWriterService, resolveSkillPriorWriterMode } from "./skill-prior-service.js";

describe("gateway verified outcome worker", () => {
  let dir: string, file: string, db: DatabaseSync, journal: EventJournal;
  let cfg: BitterbotConfig, service: SkillPriorWriterService | undefined, unsubscribe: () => void;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "prior-service-"));
    file = path.join(dir, "ledger.json");
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE skill_executions (run_id TEXT, tool_call_id TEXT, recorded_by TEXT,
      completed_at INTEGER, success INTEGER, context_json TEXT, started_at INTEGER)`);
    journal = EventJournal.open(path.join(dir, "journal.sqlite"));
    unsubscribe = onAgentEvent((e) => journal.append(e));
    cfg = { skills: { prior: { ledgerPath: file } } };
  });
  afterEach(async () => {
    await service?.close();
    service = undefined;
    unsubscribe();
    journal.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  function start() {
    service = new SkillPriorWriterService({
      db: () => db,
      journal: () => journal,
      config: () => cfg,
      feedbackOptions: { configDir: dir },
    });
    return service;
  }
  function run(
    id: string,
    reads = 1,
    owner = true,
    executed = true,
    sessionKey = "agent:main:phone:owner",
  ) {
    const taskId = "task-" + id;
    const emit = (stream: string, data: Record<string, unknown>) =>
      emitAgentEvent({ runId: id, sessionKey, taskId, stream, data });
    const proof = {
      version: 1,
      path: "/skills/report/SKILL.md",
      name: "report",
      hash: "a".repeat(64),
      complete: true,
      context: {
        runId: id,
        sessionKey,
        senderIsOwner: owner,
        task: { id: taskId, hash: "f".repeat(64), revision: 0, updatedAt: 0, author: "model" },
      },
    };
    db.prepare(
      "INSERT INTO skill_executions VALUES (?, 'read-0', 'after_tool_call', 1, 1, ?, ?)",
    ).run(id, JSON.stringify({ skillRead: proof }), Date.now());
    emit("user", { text: "make report" });
    emit("lifecycle", { phase: "start" });
    for (let i = 0; i < reads; i++) {
      emit("tool", {
        phase: "start",
        name: "read",
        toolCallId: "read-" + i,
        args: { path: proof.path },
      });
      emit("tool", { phase: "result", name: "read", toolCallId: "read-" + i, isError: false });
    }
    emitAgentEvent({
      runId: "task:" + taskId,
      taskId,
      stream: "task",
      data: {
        phase: "judged",
        runId: id,
        verdict: "pass",
        checksHash: "f".repeat(64),
        checksRevision: 0,
        checksStable: true,
        checksAuthor: "model",
        checksTotal: 1,
        checksPassed: 1,
        checksExecuted: executed ? 1 : 0,
        checksFailedExecuted: 0,
        checksIndependent: true,
      },
    });
    emit("lifecycle", { phase: "end" });
  }
  it("ships shadow, supports all config modes, and off wins when disabled", () => {
    expect(resolveSkillPriorWriterMode({})).toBe("shadow");
    for (const writer of ["shadow", "on", "off"] as const)
      expect(BitterbotSchema.safeParse({ skills: { prior: { writer } } }).success).toBe(true);
    expect(
      resolveSkillPriorWriterMode({ skills: { prior: { enabled: false, writer: "on" } } }),
    ).toBe("off");
  });
  it("runs a synthetic shadow audit, excludes repeated reads/non-owners/weak checks, and writes nothing", async () => {
    start();
    run("one");
    run("zero", 0);
    run("two", 2);
    run("visitor", 1, false);
    run("unexecuted", 1, true, false);
    run("filtered", 1, true, true, "agent:main:test:owner");
    expect(await fs.stat(file).catch(() => null)).toBeNull();
    await service!.flush();
    const rows = journal
      .query({ streams: ["skills"], limit: 100 })
      .filter((e) => e.data.phase === "prior-writer");
    expect(rows.filter((e) => e.data.status === "proposed").map((e) => e.runId)).toEqual(["one"]);
    expect(
      rows
        .filter((e) => e.data.status === "skipped")
        .map((e) => String(e.data.reason))
        .toSorted(),
    ).toEqual(
      [
        "excluded-origin",
        "checks-not-independent-or-unexecuted",
        "multiple-skill-reads",
        "no-skill-read",
        "non-owner",
      ].toSorted(),
    );
    expect(await fs.stat(file).catch(() => null)).toBeNull();
    expect((await fs.readdir(dir)).some((s) => s.includes("ledger"))).toBe(false);
  });
  it("automatically writes once after completion, reconciles on restart, and replaces late owner feedback after journal retention", async () => {
    cfg.skills!.prior!.writer = "on";
    start();
    run("one");
    await service!.flush();
    let ledger = SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8"));
    const skill = { name: "report", hash: "a".repeat(64) };
    expect(ledger.verifiedEvidence("default", skill)).toEqual({ passed: 1, runs: 1 });
    await service!.close();
    service = undefined;
    start();
    await service!.flush();
    ledger = SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8"));
    expect(ledger.verifiedEvidence("default", skill)).toEqual({ passed: 1, runs: 1 });
    journal.deleteTask("task-one");
    await appendRunFeedback(
      { runId: "one", verdict: "rejected", authority: "owner-operator" },
      { configDir: dir },
    );
    await service!.flush();
    ledger = SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8"));
    expect(ledger.verifiedEvidence("default", skill)).toEqual({ passed: 0, runs: 1 });
    await appendRunFeedback(
      { runId: "one", verdict: "confirmed", by: "operator" },
      { configDir: dir },
    );
    await service!.flush();
    expect(
      SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8")).verifiedEvidence("default", skill),
    ).toEqual({ passed: 0, runs: 1 });
  });
  it("off performs no writes or outcome work; refusal warns once and leaves corrupt state intact", async () => {
    cfg.skills!.prior!.writer = "off";
    start();
    run("one");
    await service!.flush();
    expect(journal.query({ streams: ["skills"] })).toEqual([]);
    cfg.skills!.prior!.writer = "on";
    await fs.writeFile(file, "broken");
    service!.enqueue("one");
    await service!.flush();
    service!.enqueue("one");
    await service!.flush();
    expect(await fs.readFile(file, "utf8")).toBe("broken");
    expect(
      journal.query({ streams: ["skills"] }).filter((e) => e.data.phase === "prior-writer-warning"),
    ).toHaveLength(1);
  });
});
