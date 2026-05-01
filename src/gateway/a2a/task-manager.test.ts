import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { A2aStreamEvent } from "./types.js";
import { A2aTaskManager } from "./task-manager.js";

function makeManager() {
  return new A2aTaskManager(new DatabaseSync(":memory:"), {} as never);
}

describe("A2aTaskManager", () => {
  it("creates a task in submitted state with id and stored user message", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });
    expect(task.id).toBeTruthy();
    expect(task.status.state).toBe("submitted");
    expect(task.history?.[0].parts[0]).toEqual({ type: "text", text: "hello" });
  });

  it("transitions through working → completed and stores agent reply", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "hi" }] },
    });
    m.updateStatus(task.id, "working");
    m.updateStatus(task.id, "completed", {
      role: "agent",
      parts: [{ type: "text", text: "ok" }],
    });
    const got = m.getTask(task.id);
    expect(got?.status.state).toBe("completed");
    expect(got?.history?.find((m) => m.role === "agent")?.parts[0]).toEqual({
      type: "text",
      text: "ok",
    });
  });

  it("addArtifact appends and is retrievable via getTask", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "x" }] },
    });
    m.addArtifact(task.id, {
      name: "result",
      parts: [{ type: "text", text: "the result" }],
    });
    const got = m.getTask(task.id);
    expect(got?.artifacts?.[0].name).toBe("result");
  });

  it("cancelTask returns the task with state=canceled when not yet final", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "x" }] },
    });
    const canceled = m.cancelTask(task.id);
    expect(canceled?.status.state).toBe("canceled");
  });

  it("cancelTask returns undefined for already-final tasks", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "x" }] },
    });
    m.updateStatus(task.id, "completed");
    expect(m.cancelTask(task.id)).toBeUndefined();
  });

  it("subscribe receives status events and final marker on terminal state", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "x" }] },
    });
    const events: A2aStreamEvent[] = [];
    m.subscribe(task.id, (e) => events.push(e));
    m.updateStatus(task.id, "working");
    m.updateStatus(task.id, "completed");
    const finalEvent = events.findLast((e) => e.type === "status");
    expect(finalEvent && finalEvent.type === "status" && finalEvent.final).toBe(true);
    const states = events
      .filter((e) => e.type === "status")
      .map((e) => (e.type === "status" ? e.status.state : undefined));
    expect(states).toEqual(["working", "completed"]);
  });

  it("subscribe receives artifact events", () => {
    const m = makeManager();
    const task = m.createTask({
      message: { role: "user", parts: [{ type: "text", text: "x" }] },
    });
    const events: A2aStreamEvent[] = [];
    m.subscribe(task.id, (e) => events.push(e));
    m.addArtifact(task.id, { name: "r", parts: [{ type: "text", text: "y" }] });
    expect(events.some((e) => e.type === "artifact")).toBe(true);
  });

  it("listTasks returns created tasks", () => {
    const m = makeManager();
    m.createTask({ message: { role: "user", parts: [{ type: "text", text: "a" }] } });
    m.createTask({ message: { role: "user", parts: [{ type: "text", text: "b" }] } });
    expect(m.listTasks().length).toBe(2);
  });
});
