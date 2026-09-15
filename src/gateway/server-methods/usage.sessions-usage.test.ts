import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "main") {
        return [
          {
            sessionId: "s-main",
            sessionFile: "/tmp/agents/main/sessions/s-main.jsonl",
            mtime: 100,
            firstUserMessage: "hello",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummary: vi.fn(async () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadSessionLogs: vi.fn(async () => []),
  };
});

import {
  discoverAllSessions,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("discovers sessions across configured agents and keeps agentId in key", async () => {
    const respond = vi.fn();

    await usageHandlers["sessions.usage"]({
      respond,
      params: {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        limit: 10,
      },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(discoverAllSessions).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(vi.mocked(discoverAllSessions).mock.calls[1]?.[0]?.agentId).toBe("opus");

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const result = respond.mock.calls[0]?.[1] as unknown as { sessions: Array<unknown> };
    expect(result.sessions).toHaveLength(2);

    // Sorted by most recent first (mtime=200 -> opus first).
    expect(result.sessions[0].key).toBe("agent:opus:s-opus");
    expect(result.sessions[0].agentId).toBe("opus");
    expect(result.sessions[1].key).toBe("agent:main:s-main");
    expect(result.sessions[1].agentId).toBe("main");
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-usage-test-"));
    const envSnapshot = captureEnv(["BITTERBOT_STATE_DIR"]);
    process.env.BITTERBOT_STATE_DIR = stateDir;

    try {
      const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
      fs.mkdirSync(agentSessionsDir, { recursive: true });
      const sessionFile = path.join(agentSessionsDir, "s-opus.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const respond = vi.fn();

      // Swap the store mock for this test: the canonical key differs from the discovered key
      // but points at the same sessionId.
      vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
        storePath: "(multiple)",
        store: {
          [storeKey]: {
            sessionId: "s-opus",
            sessionFile: "s-opus.jsonl",
            label: "Named session",
            updatedAt: 999,
          },
        },
      });

      // Query via discovered key: agent:<id>:<sessionId>
      await usageHandlers["sessions.usage"]({
        respond,
        params: {
          startDate: "2026-02-01",
          endDate: "2026-02-02",
          key: "agent:opus:s-opus",
          limit: 10,
        },
      } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const result = respond.mock.calls[0]?.[1] as unknown as { sessions: Array<{ key: string }> };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.key).toBe(storeKey);
      expect(vi.mocked(loadSessionCostSummary)).toHaveBeenCalled();
      expect(
        vi.mocked(loadSessionCostSummary).mock.calls.some((call) => call[0]?.agentId === "opus"),
      ).toBe(true);
    } finally {
      envSnapshot.restore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = vi.fn();

    await usageHandlers["sessions.usage"]({
      respond,
      params: {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        key: "agent:opus:../../etc/passwd",
        limit: 10,
      },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const error = respond.mock.calls[0]?.[2] as { message?: string } | undefined;
    expect(error?.message).toContain("Invalid session reference");
  });

  it("accepts the Control UI's { days, limit } params and applies the trailing window", async () => {
    // Regression: the Usage tab sends `days` (not startDate/endDate). The
    // schema is additionalProperties:false and Ajv runs with
    // removeAdditional:false, so an unlisted `days` failed validation and the
    // whole tab rendered empty. `days` must validate AND drive the window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:00:00.000Z"));
    try {
      const respond = vi.fn();
      await usageHandlers["sessions.usage"]({
        respond,
        params: { days: 7, limit: 50 },
      } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const result = respond.mock.calls[0]?.[1] as { startDate: string; endDate: string };
      expect(result.startDate).toBe("2026-01-30");
      expect(result.endDate).toBe("2026-02-05");
      const firstCall = vi.mocked(discoverAllSessions).mock.calls[0]?.[0];
      expect(firstCall?.startMs).toBe(Date.UTC(2026, 0, 30));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unknown params so the schema stays strict", async () => {
    const respond = vi.fn();
    await usageHandlers["sessions.usage"]({
      respond,
      params: { dayz: 7 },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const error = respond.mock.calls[0]?.[2] as { message?: string } | undefined;
    expect(error?.message).toContain("unexpected property 'dayz'");
  });

  it("passes parsed agentId into sessions.usage.timeseries", async () => {
    const respond = vi.fn();

    await usageHandlers["sessions.usage.timeseries"]({
      respond,
      params: {
        key: "agent:opus:s-opus",
      },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionUsageTimeSeries).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("passes parsed agentId into sessions.usage.logs", async () => {
    const respond = vi.fn();

    await usageHandlers["sessions.usage.logs"]({
      respond,
      params: {
        key: "agent:opus:s-opus",
      },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionLogs).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });
});
