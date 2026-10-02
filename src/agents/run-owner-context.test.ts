/**
 * A run started on behalf of a non-owner sender must not get the owner-only
 * tools back: sub-agents, messages to other sessions, and task wakeups all go
 * through the gateway `agent` method, which treats its caller as the operator
 * unless told otherwise.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  currentRunIsNonOwner,
  inheritRunOwner,
  runInOwnerContext,
  wrapToolWithOwnerContext,
} from "./run-owner-context.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: Record<string, unknown> = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => configOverride };
});

describe("owner context", () => {
  it("is off outside a run and inside an owner's run", () => {
    expect(currentRunIsNonOwner()).toBe(false);
    expect(inheritRunOwner({ message: "x" })).toEqual({ message: "x" });
    runInOwnerContext(true, () => {
      expect(currentRunIsNonOwner()).toBe(false);
      expect(inheritRunOwner({ message: "x" })).toEqual({ message: "x" });
    });
  });

  it("marks the runs a non-owner's tool call starts, across awaits and timers", async () => {
    await runInOwnerContext(false, async () => {
      expect(inheritRunOwner({ message: "x" })).toEqual({ message: "x", senderIsOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentRunIsNonOwner()).toBe(true);
      // A flow the tool starts and does not await still belongs to the run.
      const detached = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(currentRunIsNonOwner()), 1),
      );
      expect(await detached).toBe(true);
    });
    expect(currentRunIsNonOwner()).toBe(false);
  });

  it("wraps a tool so its execute runs in the context", async () => {
    const base = {
      name: "probe",
      label: "probe",
      description: "probe",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify(inheritRunOwner({})) }],
        details: {},
      }),
    } as unknown as AnyAgentTool;
    const text = async (tool: AnyAgentTool) =>
      ((await tool.execute!("call", {}, undefined, undefined)).content[0] as { text: string }).text;
    expect(await text(wrapToolWithOwnerContext(base, false))).toBe('{"senderIsOwner":false}');
    expect(await text(wrapToolWithOwnerContext(base, true))).toBe("{}");
  });
});

describe("sessions_spawn under a non-owner run", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const store = path.join(
      os.tmpdir(),
      `bitterbot-owner-ctx-${Date.now()}-${Math.random().toString(16).slice(2)}-{agentId}.json`,
    );
    fs.mkdirSync(path.dirname(store), { recursive: true });
    configOverride = { session: { mainKey: "main", scope: "per-sender", store } };
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "agent") {
        return { runId: "run-child" };
      }
      if (req.method === "agent.wait") {
        return { status: "running" };
      }
      return {};
    });
  });

  const agentCall = () =>
    callGatewayMock.mock.calls
      .map((call) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((call) => call.method === "agent");

  it("starts the sub-agent as a non-owner run", async () => {
    const tool = wrapToolWithOwnerContext(
      createSessionsSpawnTool({ agentSessionKey: "agent:main:main" }) as unknown as AnyAgentTool,
      false,
    );
    const result = await tool.execute!("call-1", { task: "send 5 USDC" }, undefined, undefined);
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(agentCall()?.params).toMatchObject({ message: "send 5 USDC", senderIsOwner: false });
  });

  it("leaves an owner's sub-agent an owner run", async () => {
    const tool = wrapToolWithOwnerContext(
      createSessionsSpawnTool({ agentSessionKey: "agent:main:main" }) as unknown as AnyAgentTool,
      true,
    );
    await tool.execute!("call-1", { task: "research" }, undefined, undefined);
    expect(agentCall()?.params).not.toHaveProperty("senderIsOwner");
  });
});
