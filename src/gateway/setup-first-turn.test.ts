import { describe, expect, it } from "vitest";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import {
  presentTurnError,
  runSetupFirstTurn,
  sanitizeReply,
  SETUP_FIRST_TURN_PROMPT,
} from "./setup-first-turn.js";

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
  it("runs the hello prompt through the agent RPC in the setup session and measures latency", async () => {
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
      // Never the main chat: retries stay out of the user's transcript.
      sessionKey: "agent:main:setup",
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
    expect(outcome).toMatchObject({ ok: false });
    expect(JSON.stringify(outcome)).toContain("401 invalid x-api-key");
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

describe("runSetupFirstTurn timeout and errors", () => {
  it("aborts the run when it outlives its budget, before setup offers Retry", async () => {
    const aborted: string[] = [];
    let respondLater: ((ok: boolean, payload?: unknown) => void) | undefined;
    const outcome = await runSetupFirstTurn({
      cfg: {},
      context,
      timeoutMs: 20,
      abortRun: (key) => void aborted.push(key),
      agentHandler: ({ respond }) => {
        respond(true, { runId: "r", status: "accepted" });
        respondLater = (ok, payload) => respond(ok, payload);
      },
    });
    expect(outcome).toMatchObject({ ok: false, error: "no reply within 0s" });
    expect(aborted).toEqual(["agent:main:setup"]);
    // A late final frame after the abort changes nothing.
    respondLater?.(true, { status: "ok", result: { payloads: [{ text: "late" }] } });
  });

  it("masks a key the provider echoed in its error", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const outcome = await runSetupFirstTurn({
      cfg: {},
      context,
      agentHandler: handler({
        ok: false,
        payload: { status: "error", summary: `401 invalid x-api-key: ${secret}` },
        error: { code: "UNAVAILABLE", message: `401 invalid x-api-key: ${secret}` },
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain("401 invalid x-api-key");
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(presentTurnError(`Bearer ${secret}`)).not.toContain(secret);
  });
});

describe("sanitizeReply", () => {
  it("keeps printable text and newlines, bounded", () => {
    expect(sanitizeReply("hi\u0007\nthere")).toBe("hi\nthere");
    expect(sanitizeReply("x".repeat(20), 5)).toBe("xxxxx...");
  });
});
