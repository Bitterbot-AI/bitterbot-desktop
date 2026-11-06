import { describe, expect, it } from "vitest";
import type { SkillReadProof } from "../agents/skills/skill-read-provenance.js";
import type { JournalEvent } from "../infra/event-journal.js";
import { selectSkillPriorOutcome } from "./skill-prior-outcome.js";

function fixture() {
  const event = (seq: number, stream: string, data: Record<string, unknown>): JournalEvent => ({
    seq,
    runSeq: seq,
    runId: "run-1",
    taskId: "task-1",
    ts: 1000 + seq,
    sessionKey: "agent:main:main",
    stream,
    data,
  });
  const proof: SkillReadProof = {
    version: 1,
    path: "/skills/format/SKILL.md",
    name: "format",
    hash: "a".repeat(64),
    complete: true,
    context: {
      runId: "run-1",
      senderIsOwner: true,
      sessionKey: "agent:main:main",
      task: { id: "task-1", hash: "f".repeat(64), revision: 0, updatedAt: 0, author: "model" },
    },
  };
  const events = [
    event(1, "user", { text: "produce an artifact" }),
    event(2, "lifecycle", { phase: "start" }),
    event(3, "tool", {
      phase: "start",
      name: "read",
      toolCallId: "read-1",
      args: { path: proof.path },
    }),
    event(4, "tool", { phase: "result", name: "read", toolCallId: "read-1", isError: false }),
    event(6, "lifecycle", { phase: "end" }),
  ];
  const taskEvents = [
    event(5, "task", {
      phase: "judged",
      runId: "run-1",
      verdict: "pass",
      checksHash: "f".repeat(64),
      checksRevision: 0,
      checksAuthor: "model",
      checksStable: true,
      checksTotal: 1,
      checksPassed: 1,
      checksExecuted: 1,
      checksFailedExecuted: 0,
      checksIndependent: true,
    }),
  ];
  const input: Parameters<typeof selectSkillPriorOutcome>[0] = {
    runId: "run-1",
    events,
    taskEvents,
    completeHistory: true,
    executions: [
      {
        run_id: "run-1",
        tool_call_id: "read-1",
        recorded_by: "after_tool_call",
        success: 1,
        completed_at: 1004,
        context_json: JSON.stringify({ skillRead: proof }),
      },
    ],
  };
  const saveProof = () => {
    input.executions[0].context_json = JSON.stringify({ skillRead: proof });
  };
  return { input, proof, saveProof, event };
}

describe("verified skill outcome selection", () => {
  it("credits a single full read with frozen executed checks, using the recorded hash", () => {
    const { input } = fixture();
    expect(selectSkillPriorOutcome(input)).toMatchObject({
      reason: "verified",
      credit: {
        skill: { hash: "a".repeat(64) },
        outcome: 1,
        source: "task-checks",
        author: "model",
      },
    });
  });
  it("accepts an executed check failure and never substitutes a judge-only failure", () => {
    const { input } = fixture();
    Object.assign(input.taskEvents[0].data, {
      verdict: "fail",
      checksPassed: 0,
      checksFailedExecuted: 1,
    });
    expect(selectSkillPriorOutcome(input).credit?.outcome).toBe(0);
    Object.assign(input.taskEvents[0].data, { checksPassed: 1, checksFailedExecuted: 0 });
    expect(selectSkillPriorOutcome(input).credit).toBeUndefined();
  });
  it.each(["confirmed", "rejected"] as const)(
    "accepts explicit owner %s and overrides checks",
    (verdict) => {
      const { input } = fixture();
      input.feedback = {
        runId: input.runId,
        verdict,
        by: "ignored",
        note: null,
        ts: 2000,
        eventId: "feedback-1",
        sequence: 1,
        authority: "owner-operator",
      };
      expect(selectSkillPriorOutcome(input).credit).toMatchObject({
        outcome: verdict === "confirmed" ? 1 : 0,
        source: "owner-feedback",
        author: "operator",
      });
    },
  );
  it("counts an untracked read whose parameters were rewritten to SKILL.md", () => {
    const { input, event } = fixture();
    input.events.splice(
      4,
      0,
      event(4, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "rewritten",
        args: { path: "notes.md" },
      }),
      event(5, "tool", {
        phase: "result",
        name: "read",
        toolCallId: "rewritten",
        result: { details: { skillReadPath: "/untracked/SKILL.md" } },
      }),
    );
    expect(selectSkillPriorOutcome(input).reason).toBe("multiple-skill-reads");
  });
  it("does not credit a run that has begun another attempt", () => {
    const { input, event } = fixture();
    input.events.push(event(7, "lifecycle", { phase: "start" }));
    expect(selectSkillPriorOutcome(input).reason).toBe("unfinished");
  });
  it.each([0, 2, 3])("rejects %i skill reads, including repeats and untracked reads", (count) => {
    const { input, event } = fixture();
    input.events = input.events.filter((e) => !(e.stream === "tool" && e.data.phase === "start"));
    for (let i = 0; i < count; i++)
      input.events.splice(
        2,
        0,
        event(3, "tool", {
          phase: "start",
          name: "read",
          toolCallId: "read-" + i,
          args: { path: i === 2 ? "SKILL.md" : "/other/SKILL.md" },
        }),
      );
    expect(selectSkillPriorOutcome(input).reason).toBe(
      count ? "multiple-skill-reads" : "no-skill-read",
    );
  });
  it.each([
    ["disabled check", { checksExecuted: 0 }],
    ["partial execution", { checksTotal: 2 }],
    ["judge-only L3", { checksTotal: 0, checksPassed: 0, checksExecuted: 0 }],
    ["self-reported output", { checksIndependent: false }],
    ["unbound verdict", { runId: null }],
    ["changed hash", { checksHash: "new" }],
    ["changed then restored", { checksRevision: 2 }],
    ["changed during judge", { checksStable: false }],
    ["unknown outcome", { verdict: "needs_more" }],
    ["legacy record", { checksExecuted: undefined }],
  ])("skips %s", (_name, change) => {
    const { input } = fixture();
    Object.assign(input.taskEvents[0].data, change);
    expect(selectSkillPriorOutcome(input).credit).toBeUndefined();
  });
  it("rejects changes before the read, and changes after judging but before run completion", () => {
    const { input, proof, saveProof, event } = fixture();
    proof.context!.task!.updatedAt = 1002;
    saveProof();
    expect(selectSkillPriorOutcome(input).reason).toBe("checks-changed");
    proof.context!.task!.updatedAt = 0;
    saveProof();
    input.taskEvents.push(event(6, "task", { phase: "checks_changed", revision: 1 }));
    expect(selectSkillPriorOutcome(input).reason).toBe("checks-changed");
  });
  it.each(["agent:main:phone:visitor", "agent:main:main"])(
    "never treats a non-owner run as owner (%s)",
    (session) => {
      const { input, proof, saveProof } = fixture();
      input.events.forEach((e) => {
        e.sessionKey = session;
      });
      proof.context!.sessionKey = session;
      proof.context!.senderIsOwner = false;
      saveProof();
      input.feedback = {
        runId: "run-1",
        verdict: "confirmed",
        by: "operator",
        note: null,
        ts: 2000,
        eventId: "f",
        sequence: 1,
        authority: "owner-operator",
      };
      expect(selectSkillPriorOutcome(input).reason).toBe("non-owner");
    },
  );
  it.each([
    "agent:main:a2a:remote",
    "agent:main:guest",
    "agent:main:benchmark:1",
    "agent:main:harness:1",
  ])("excludes %s", (session) => {
    const { input } = fixture();
    input.events.forEach((e) => {
      e.sessionKey = session;
    });
    expect(selectSkillPriorOutcome(input).reason).toBe("excluded-origin");
  });
  it("skips reads alone, clean tools, claimed human identity, and environment failures", () => {
    const { input } = fixture();
    input.taskEvents = [];
    input.feedback = { runId: "run-1", verdict: "confirmed", by: "operator", note: null, ts: 2000 };
    expect(selectSkillPriorOutcome(input).credit).toBeUndefined();
    input.events.at(-1)!.data.phase = "error";
    expect(selectSkillPriorOutcome(input).reason).toBe("environment-or-unknown-failure");
  });
  it.each(["complete", "owner"])("rejects truthy non-boolean %s metadata", (field) => {
    const { input, proof } = fixture();
    const altered =
      field === "complete"
        ? { ...proof, complete: "true" }
        : { ...proof, context: { ...proof.context, senderIsOwner: "false" } };
    input.executions[0].context_json = JSON.stringify({ skillRead: altered });
    expect(selectSkillPriorOutcome(input).credit).toBeUndefined();
  });
  it.each(["partial", "missing", "unknown", "incomplete-history", "missing-execution"])(
    "fails closed on %s evidence",
    (kind) => {
      const { input, proof, saveProof } = fixture();
      if (kind === "partial") proof.complete = false;
      if (kind === "unknown") proof.hash = "unknown";
      saveProof();
      if (kind === "missing") input.executions[0].context_json = null;
      if (kind === "missing-execution") input.executions = [];
      if (kind === "incomplete-history") input.completeHistory = false;
      expect(selectSkillPriorOutcome(input).credit).toBeUndefined();
    },
  );
});
