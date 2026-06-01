import { describe, expect, it, vi } from "vitest";
import type { PreTurnContext, PreTurnPayload } from "./pre-turn-decision.js";
import { buildAutoInitiationDecider } from "./auto-initiate-decider.js";

const CTX: PreTurnContext = { sessionKey: "s1", agentId: "a1", runId: "r1", channel: "web" };
const BASE: PreTurnPayload = {
  message: "refactor everything and open a PR",
  extraSystemPrompt: undefined,
};

const taskDecision = {
  mode: "task" as const,
  taskId: "task-7",
  ack: "Started task task-7. Reply 'just answer' to skip.",
  firstSlice: "You are working on task task-7. Goal: refactor everything.",
  oracleKind: "mechanical" as const,
  verdict: {} as never,
};
const inlineDecision = { mode: "inline" as const, reason: "below", verdict: {} as never };

describe("buildAutoInitiationDecider", () => {
  it("is a no-op when both flags are off", async () => {
    const initiate = vi.fn();
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => false,
      gateEnabled: () => false,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider(BASE, CTX);
    expect(out).toEqual(BASE);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("appraises but does not create or mutate in telemetry-only mode (gate on, auto off)", async () => {
    const initiate = vi.fn();
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => false,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider(BASE, CTX);
    expect(out).toEqual(BASE);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("leaves the payload unchanged when the decision is inline (auto on)", async () => {
    const initiate = vi.fn(async () => inlineDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({ cortisol: 0.1, dopamine: 0.2 }),
      initiate: initiate as never,
    });
    const out = await decider(BASE, CTX);
    expect(out).toEqual(BASE);
    expect(initiate).toHaveBeenCalledTimes(1);
  });

  it("augments extraSystemPrompt with the first slice and ack on a task decision", async () => {
    const initiate = vi.fn(async () => taskDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider(BASE, CTX);
    expect(out.message).toBe(BASE.message); // message untouched
    expect(out.extraSystemPrompt).toContain(taskDecision.firstSlice);
    expect(out.extraSystemPrompt).toContain(taskDecision.ack);
  });

  it("appends to an existing extraSystemPrompt rather than replacing it", async () => {
    const initiate = vi.fn(async () => taskDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider({ message: BASE.message, extraSystemPrompt: "PRIOR" }, CTX);
    expect(out.extraSystemPrompt?.startsWith("PRIOR")).toBe(true);
    expect(out.extraSystemPrompt).toContain(taskDecision.firstSlice);
  });

  it("passes the session key and modulators through to the initiator", async () => {
    const initiate = vi.fn(async () => inlineDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({ cortisol: 0.9 }),
      initiate: initiate as never,
    });
    await decider(BASE, CTX);
    expect(initiate).toHaveBeenCalledWith(
      { prompt: BASE.message, agentSessionKey: "s1", source: "user" },
      { modulators: { cortisol: 0.9 } },
    );
  });
});
