import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { StepContext } from "../interceptor.js";
import { __testing as ctxTesting } from "../interceptor-context.js";
import { calibrateClaimConfidence } from "./calibrate-claim-confidence.js";
import { MESSAGE_TOOL_NAMES } from "./message-tools.js";
import { protocolQuietInGroups } from "./protocol-quiet-in-groups.js";
import { recallBeforeClaim } from "./recall-before-claim.js";
import { routeByQueryShape } from "./route-by-query-shape.js";

function mkCtx(over: Partial<StepContext> = {}): StepContext {
  return {
    sessionKey: "test",
    agentId: "main",
    channel: "internal",
    turnNumber: 1,
    hormonal: ctxTesting.NEUTRAL_HORMONAL,
    gccrf: ctxTesting.NEUTRAL_GCCRF,
    recentTurns: [],
    toolHistory: [],
    draftReply: undefined,
    activeTask: undefined,
    ...over,
  } as StepContext;
}

// Audit 2026-08-09 F4: the message interceptors bound to phantom tool names
// (send_message, discord_send, ...) that are not real registered tools, so
// they could never activate and intervention_records stayed empty forever.
// Guard: every message interceptor must bind to the REAL tool names, and
// never to the phantom ones.
describe("message interceptor tool bindings (F4 regression)", () => {
  const messageInterceptors = [recallBeforeClaim, protocolQuietInGroups, calibrateClaimConfidence];
  const PHANTOM = ["send_message", "discord_send", "telegram_send", "whatsapp_send", "slack_send"];

  it("shared MESSAGE_TOOL_NAMES contains the real tools only", () => {
    expect(MESSAGE_TOOL_NAMES).toContain("message");
    expect(MESSAGE_TOOL_NAMES).toContain("sessions_send");
    for (const phantom of PHANTOM) expect(MESSAGE_TOOL_NAMES).not.toContain(phantom);
  });

  it("every message interceptor binds the real 'message' tool, no phantoms", () => {
    for (const ic of messageInterceptors) {
      expect(ic.tools).toContain("message");
      for (const phantom of PHANTOM) expect(ic.tools).not.toContain(phantom);
    }
  });
});

describe("recall-before-claim", () => {
  it("fires on a confident factual assertion with no recent memory tool", () => {
    const ctx = mkCtx({ draftReply: "Anthropic was founded in 2021." });
    const should = recallBeforeClaim.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(true);
  });

  it("does NOT fire when memory_search just ran", () => {
    const ctx = mkCtx({
      draftReply: "Anthropic was founded in 2021.",
      toolHistory: [{ tool: "memory_search", success: true, tsDelta: 5000 }],
    });
    const should = recallBeforeClaim.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(false);
  });

  it("does NOT fire on opinion shapes", () => {
    const ctx = mkCtx({ draftReply: "I think Anthropic was founded recently." });
    const should = recallBeforeClaim.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(false);
  });

  it("returns require_prereq with the subject as the query", () => {
    const ctx = mkCtx({ draftReply: "Anthropic released Claude 4.6." });
    const intervention = recallBeforeClaim.intervene(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(intervention).toMatchObject({
      type: "require_prereq",
      tool: "memory_search",
    });
  });

  it("covers the webchat 'message' tool (Gap 2)", () => {
    // The default webchat reply tool is named "message"; it must be in the
    // interceptor's tool filter or recall-before-claim never fires for it.
    expect(recallBeforeClaim.tools).toContain("message");
  });

  it("fires on a denial/negation claim even without a positive assertion (Gap 3)", () => {
    // "636M tokens" has no capitalized subject for ASSERTION_RX, but denying a
    // fact the agent actually has stored is exactly the failure we guard.
    const ctx = mkCtx({ draftReply: "That 636M tokens figure is hallucinated." });
    const should = recallBeforeClaim.shouldActivate(ctx, {
      toolName: "message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(true);
  });

  it("still skips a negation when memory was just consulted", () => {
    const ctx = mkCtx({
      draftReply: "OpenClaw doesn't exist.",
      toolHistory: [{ tool: "memory_search", success: true, tsDelta: 4000 }],
    });
    const should = recallBeforeClaim.shouldActivate(ctx, {
      toolName: "message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(false);
  });
});

describe("route-by-query-shape", () => {
  it("fires on relationship-shaped memory_search queries", () => {
    const ctx = mkCtx();
    const should = routeByQueryShape.shouldActivate(ctx, {
      toolName: "memory_search",
      params: { query: "who did I talk to about Foo?" },
    });
    expect(should).toBe(true);
  });

  it("does NOT fire on generic content queries", () => {
    const ctx = mkCtx();
    const should = routeByQueryShape.shouldActivate(ctx, {
      toolName: "memory_search",
      params: { query: "details about pricing" },
    });
    expect(should).toBe(false);
  });

  it("requires deep_recall as prereq when it fires", () => {
    const ctx = mkCtx();
    const intervention = routeByQueryShape.intervene(ctx, {
      toolName: "memory_search",
      params: { query: "who talked about Foo" },
    });
    expect(intervention).toMatchObject({
      type: "require_prereq",
      tool: "deep_recall",
    });
  });
});

describe("protocol-quiet-in-groups", () => {
  it("blocks in a discord group when not @mentioned and recently spoke", () => {
    const ctx = mkCtx({
      channel: "discord",
      recentTurns: [
        { role: "user", preview: "anyone got an update?" },
        { role: "assistant", preview: "yes here is one" },
        { role: "user", preview: "ok thanks" },
      ],
      toolHistory: [{ tool: "message", success: true, tsDelta: 8000 }],
      turnNumber: 12,
    });
    const should = protocolQuietInGroups.shouldActivate(ctx, {
      toolName: "message",
      params: { content: "and another thing" },
    });
    expect(should).toBe(true);
  });

  it("does NOT block in an internal (non-group) session", () => {
    const ctx = mkCtx({ channel: "internal" });
    const should = protocolQuietInGroups.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: "hi" },
    });
    expect(should).toBe(false);
  });

  it("does NOT block when the user @mentioned the bot", () => {
    const ctx = mkCtx({
      channel: "discord",
      recentTurns: [{ role: "user", preview: "@bitterbot help" }],
      toolHistory: [{ tool: "discord_send", success: true, tsDelta: 8000 }],
      turnNumber: 12,
    });
    const should = protocolQuietInGroups.shouldActivate(ctx, {
      toolName: "discord_send",
      params: { content: "sure" },
    });
    expect(should).toBe(false);
  });
});

describe("calibrate-claim-confidence", () => {
  it("fires when empowerment is low + falling certainty + confident absolute in draft", () => {
    const ctx = mkCtx({
      gccrf: { ...ctxTesting.NEUTRAL_GCCRF, empowerment: 0.1, certaintyDelta: -0.2 },
      draftReply: "This is definitely the right answer.",
    });
    const should = calibrateClaimConfidence.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(true);
  });

  it("does NOT fire when empowerment is high", () => {
    const ctx = mkCtx({
      gccrf: { ...ctxTesting.NEUTRAL_GCCRF, empowerment: 0.8, certaintyDelta: 0.1 },
      draftReply: "This is definitely the right answer.",
    });
    const should = calibrateClaimConfidence.shouldActivate(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(should).toBe(false);
  });

  it("rewrites absolutes into hedged form", () => {
    const ctx = mkCtx({
      gccrf: { ...ctxTesting.NEUTRAL_GCCRF, empowerment: 0.1, certaintyDelta: -0.2 },
      draftReply: "This is definitely the right answer.",
    });
    const intervention = calibrateClaimConfidence.intervene(ctx, {
      toolName: "send_message",
      params: { text: ctx.draftReply },
    });
    expect(intervention.type).toBe("modify");
    if (intervention.type === "modify") {
      const newText = (intervention.newParams as { text: string }).text;
      expect(newText.toLowerCase()).toContain("likely");
      expect(newText.toLowerCase()).not.toContain("definitely");
    }
  });
});
