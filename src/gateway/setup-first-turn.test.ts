import { describe, expect, it } from "vitest";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { runSetupFirstTurn, sanitizeReply, SETUP_FIRST_TURN_PROMPT } from "./setup-first-turn.js";

const context = {} as GatewayRequestContext;

function handler(
  final: { ok: boolean; payload?: unknown; error?: { code: string; message: string } },
  seen: Array<Record<string, unknown>> = [],
): GatewayRequestHandler {
  return ({ params, respond }) => {
    seen.push(params);
    // The agent RPC acks first, then sends the final frame (expectFinal).
    respond(true, { runId: "r", status: "accepted" });
    setTimeout(() => respond(final.ok, final.payload, final.error as never), 1);
  };
}

describe("runSetupFirstTurn", () => {
  it("runs the hello prompt through the agent RPC on the main session and measures latency", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let t = 1000;
    const outcome = await runSetupFirstTurn({
      cfg: {},
      context,
      now: () => (t += 750),
      agentHandler: handler(
        {
          ok: true,
          payload: {
            status: "ok",
            result: {
              payloads: [{ text: "Hello! I can remember what you tell me." }],
              meta: { agentMeta: { provider: "anthropic", model: "claude-opus-4-8" } },
            },
          },
        },
        seen,
      ),
    });
    expect(outcome).toEqual({
      ok: true,
      latencyMs: 750,
      reply: "Hello! I can remember what you tell me.",
      model: "anthropic/claude-opus-4-8",
    });
    expect(seen[0]).toMatchObject({
      message: SETUP_FIRST_TURN_PROMPT,
      sessionKey: "agent:main:main",
      deliver: false,
    });
    expect(SETUP_FIRST_TURN_PROMPT).toBe("Say hello and tell me one thing you can do.");
  });

  it("returns the provider error when the turn fails", async () => {
    const outcome = await runSetupFirstTurn({
      cfg: {},
      context,
      agentHandler: handler({
        ok: false,
        payload: { status: "error", summary: "Error: 401 invalid x-api-key" },
        error: { code: "UNAVAILABLE", message: "Error: 401 invalid x-api-key" },
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("401 invalid x-api-key");
  });

  it("treats an error-only reply as a failure", async () => {
    const outcome = await runSetupFirstTurn({
      cfg: {},
      context,
      agentHandler: handler({
        ok: true,
        payload: {
          status: "ok",
          result: {
            payloads: [{ text: "No API key found for provider anthropic", isError: true }],
          },
        },
      }),
    });
    expect(outcome).toMatchObject({ ok: false, error: "No API key found for provider anthropic" });
  });
});

describe("sanitizeReply", () => {
  it("keeps printable text and newlines, bounded", () => {
    expect(sanitizeReply("hi\u0007\nthere")).toBe("hi\nthere");
    expect(sanitizeReply("x".repeat(20), 5)).toBe("xxxxx...");
  });
});
