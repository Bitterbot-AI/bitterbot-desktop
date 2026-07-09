import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreTurnContext, PreTurnPayload } from "./pre-turn-decision.js";
import { wrapExternalContent } from "../../security/external-content.js";
import {
  buildAutoInitiationDecider,
  isAutoInitiateEnabled,
  isComplexityGateEnabled,
} from "./auto-initiate-decider.js";

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

describe("env flag defaults", () => {
  const prev = {
    gate: process.env.BITTERBOT_TASKS_COMPLEXITY_GATE,
    auto: process.env.BITTERBOT_TASKS_AUTO_INITIATE,
  };
  afterEach(() => {
    if (prev.gate === undefined) delete process.env.BITTERBOT_TASKS_COMPLEXITY_GATE;
    else process.env.BITTERBOT_TASKS_COMPLEXITY_GATE = prev.gate;
    if (prev.auto === undefined) delete process.env.BITTERBOT_TASKS_AUTO_INITIATE;
    else process.env.BITTERBOT_TASKS_AUTO_INITIATE = prev.auto;
  });

  it("complexity gate is on by default and off only when set to 0", () => {
    delete process.env.BITTERBOT_TASKS_COMPLEXITY_GATE;
    expect(isComplexityGateEnabled()).toBe(true);
    process.env.BITTERBOT_TASKS_COMPLEXITY_GATE = "0";
    expect(isComplexityGateEnabled()).toBe(false);
  });

  it("auto-initiate is on by default and off only when explicitly disabled", () => {
    delete process.env.BITTERBOT_TASKS_AUTO_INITIATE;
    expect(isAutoInitiateEnabled()).toBe(true);
    process.env.BITTERBOT_TASKS_AUTO_INITIATE = "1";
    expect(isAutoInitiateEnabled()).toBe(true);
    process.env.BITTERBOT_TASKS_AUTO_INITIATE = "0";
    expect(isAutoInitiateEnabled()).toBe(false);
    process.env.BITTERBOT_TASKS_AUTO_INITIATE = "false";
    expect(isAutoInitiateEnabled()).toBe(false);
  });
});

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

describe("untrusted external content never auto-initiates a task", () => {
  // Regression: a peer agent's bare "hi" arrives WRAPPED in the ~770-char
  // security envelope. The complexity appraiser scored the wrapper's bullet
  // list (enumeration=9, prose≈770) as a multi-step brief and spawned a
  // phantom task whose goal was the security notice itself. Wrapped content
  // is a hostile principal and must never drive task creation.
  const wrappedHi = wrapExternalContent("hi", { source: "a2a_agent", sender: "peer" });

  it("skips auto-initiation for a wrapped peer message BEFORE appraisal", async () => {
    const initiate = vi.fn(async () => taskDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider({ message: wrappedHi }, CTX);
    expect(out).toEqual({ message: wrappedHi });
    // The initiator is never even consulted — the refusal precedes appraisal.
    expect(initiate).not.toHaveBeenCalled();
  });

  it("suppresses auto-initiation even for a long, list-heavy wrapped payload", async () => {
    // A hostile peer shaping length + enumeration to farm task creation.
    const hostile = wrapExternalContent(
      "1. do this\n2. then that\n3. also this\n4. and that\n5. more\n" + "x".repeat(2000),
      { source: "a2a_agent", sender: "attacker" },
    );
    const initiate = vi.fn(async () => taskDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider({ message: hostile }, CTX);
    expect(out.extraSystemPrompt).toBeUndefined();
    expect(initiate).not.toHaveBeenCalled();
  });

  it("still auto-initiates a genuine (unwrapped) multi-step user brief", async () => {
    const initiate = vi.fn(async () => taskDecision);
    const decider = buildAutoInitiationDecider({
      autoEnabled: () => true,
      gateEnabled: () => true,
      modulators: () => ({}),
      initiate: initiate as never,
    });
    const out = await decider(BASE, CTX);
    expect(initiate).toHaveBeenCalledTimes(1);
    expect(out.extraSystemPrompt).toContain(taskDecision.firstSlice);
  });
});
