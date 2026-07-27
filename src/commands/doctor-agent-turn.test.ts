import { beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.hoisted(() => vi.fn());
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-fixed",
}));

import type { BitterbotConfig } from "../config/config.js";
import {
  classifyAgentTurn,
  collectProbeOrphans,
  runAgentTurnRoundTrip,
} from "./doctor-agent-turn.js";

// The classifier IS the severity policy: probe failures are warn-only during
// burn-in so a flaky full-pipeline probe can never block fleet updates.

describe("classifyAgentTurn", () => {
  it("ok on a successful round-trip", () => {
    const r = classifyAgentTurn({ kind: "ok", latencyMs: 4200, sample: "OK" });
    expect(r.level).toBe("ok");
    expect(r.message).toContain("4200ms");
  });

  it("info when skipped", () => {
    const r = classifyAgentTurn({ kind: "skipped", reason: "update in progress" });
    expect(r.level).toBe("info");
  });

  it("WARNS (never errors) on any failure — burn-in severity", () => {
    for (const message of [
      'gateway returned status "error" (send policy denied)',
      "turn completed but produced no text payload",
      "timeout",
      "socket hang up",
    ]) {
      const r = classifyAgentTurn({ kind: "error", message });
      expect(r.level, message).toBe("warn");
      expect(r.message).toContain(message);
    }
  });
});

describe("collectProbeOrphans", () => {
  it("selects only probe-session keys and spares the current one", () => {
    const keys = collectProbeOrphans(
      [
        { key: "agent:main:doctor-probe-a1b2c3d4" },
        { key: "agent:main:doctor-probe-ffffffff" },
        { key: "agent:main:main" },
        { key: "whatsapp:+15551234" },
        {},
      ],
      "agent:main:doctor-probe-ffffffff",
    );
    expect(keys).toEqual(["agent:main:doctor-probe-a1b2c3d4"]);
  });

  it("returns empty on a clean session list", () => {
    expect(collectProbeOrphans([{ key: "agent:main:main" }])).toEqual([]);
  });
});

describe("runAgentTurnRoundTrip RPC contract", () => {
  // The gateway's AgentParamsSchema is additionalProperties:false with
  // `timeout` in SECONDS — a renamed field or a ms value breaks the probe
  // outright, so pin the exact request shape against the mock.
  const cfg = {} as BitterbotConfig;

  const callsFor = (method: string) =>
    callGateway.mock.calls.filter((c) => c[0]?.method === method).map((c) => c[0]);

  beforeEach(() => {
    callGateway.mockReset();
    // Defeat the test-env skip so the probe actually runs under vitest.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BITTERBOT_UPDATE_IN_PROGRESS", "");
  });

  function mockHappyGateway() {
    callGateway.mockImplementation(async (req: { method: string }) => {
      if (req.method === "sessions.list") return { sessions: [] };
      if (req.method === "sessions.delete") return {};
      if (req.method === "agent") {
        return { status: "ok", result: { payloads: [{ text: "OK" }] } };
      }
      throw new Error(`unexpected method ${req.method}`);
    });
  }

  it("sends exactly the schema-valid agent params and reaps the session", async () => {
    mockHappyGateway();
    const outcome = await runAgentTurnRoundTrip(cfg);
    expect(outcome.kind).toBe("ok");

    const [agentCall] = callsFor("agent");
    expect(agentCall).toBeTruthy();
    expect(agentCall.expectFinal).toBe(true);
    const params = agentCall.params as Record<string, unknown>;
    expect(Object.keys(params).toSorted()).toEqual([
      "agentId",
      "channel",
      "deliver",
      "idempotencyKey",
      "message",
      "sessionKey",
      "timeout",
    ]);
    expect(params.timeout).toBe(60); // seconds, NOT ms
    expect(params.deliver).toBe(false);
    expect(String(params.sessionKey)).toMatch(/^agent:.+:doctor-probe-[0-9a-f]{8}$/);

    // The reap fires with the same key and archives the transcript.
    const deletes = callsFor("sessions.delete");
    expect(deletes.some((d) => d.params.key === params.sessionKey)).toBe(true);
    expect(deletes[0]?.params.deleteTranscript).toBe(true);
  });

  it("reaps the probe session even when the agent call throws", async () => {
    callGateway.mockImplementation(async (req: { method: string }) => {
      if (req.method === "sessions.list") return { sessions: [] };
      if (req.method === "sessions.delete") return {};
      throw new Error("timeout");
    });
    const outcome = await runAgentTurnRoundTrip(cfg);
    expect(outcome.kind).toBe("error");
    expect(callsFor("sessions.delete")).toHaveLength(1);
  });

  it("classifies a non-ok final status as an error outcome", async () => {
    callGateway.mockImplementation(async (req: { method: string }) => {
      if (req.method === "agent") return { status: "error", summary: "send policy denied" };
      return { sessions: [] };
    });
    const outcome = await runAgentTurnRoundTrip(cfg);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("send policy denied");
    }
  });

  it("skips before creating any session while an update is in progress", async () => {
    vi.stubEnv("BITTERBOT_UPDATE_IN_PROGRESS", "1");
    const outcome = await runAgentTurnRoundTrip(cfg);
    expect(outcome.kind).toBe("skipped");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("runs during an update when forceDuringUpdate is set (post-restart doctor)", async () => {
    vi.stubEnv("BITTERBOT_UPDATE_IN_PROGRESS", "1");
    mockHappyGateway();
    const outcome = await runAgentTurnRoundTrip(cfg, { forceDuringUpdate: true });
    expect(outcome.kind).toBe("ok");
  });
});
