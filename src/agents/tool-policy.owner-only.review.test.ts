/**
 * From the adversarial review of the owner-only money tools, on the REAL tool
 * factory. A non-owner tool set has no `wallet`, `a2a_client` or `gateway`,
 * directly or through `use_tool`. It keeps the tools that start another run
 * (`sessions_spawn`, `sessions_send`, task wakeups); those runs inherit the
 * non-owner status (see run-owner-context.test.ts) instead of being built as
 * owner runs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import { buildIsolatedAgentTurnParams } from "../cron/isolated-agent.js";
import { validateAgentParams } from "../gateway/protocol/index.js";
import { createBitterbotCodingTools } from "./agent-tools.js";
import { USE_TOOL_NAME } from "./tools/tool-dispatcher-tool.js";

let ws: string;
beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "owner-only-review-"));
});
afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

const moneyConfig = (hotSet: boolean) =>
  ({
    tools: { wallet: { enabled: true }, hotSet: { enabled: hotSet } },
    a2a: { enabled: true, marketplace: { enabled: true, client: {} } },
  }) as unknown as BitterbotConfig;

function build(extra: Parameters<typeof createBitterbotCodingTools>[0] = {}) {
  return createBitterbotCodingTools({
    sessionKey: "agent:main:main",
    workspaceDir: ws,
    agentDir: path.join(ws, "agents", "main", "agent"),
    config: moneyConfig(false),
    ...extra,
  });
}

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

describe("owner-only money tools (review)", () => {
  it("sanity: an owner gets wallet and a2a_client", () => {
    const owner = names(build({ senderIsOwner: true }));
    expect(owner).toContain("wallet");
    expect(owner).toContain("a2a_client");
  });

  it("holds: a non-owner has neither, directly or through use_tool", async () => {
    const direct = names(build({ senderIsOwner: false }));
    expect(direct).not.toContain("wallet");
    expect(direct).not.toContain("a2a_client");

    const dispatched = build({ senderIsOwner: false, config: moneyConfig(true) });
    const useTool = dispatched.find((tool) => tool.name === USE_TOOL_NAME);
    expect(useTool).toBeDefined();
    const result = await useTool!.execute!(
      "call-1",
      { name: "wallet", input: { action: "get_address" } },
      undefined,
      undefined,
    );
    expect(JSON.stringify(result)).toContain("unknown tool");
  });

  it("a non-owner cannot reach the gateway tool, which can rewrite config", () => {
    const nonOwner = names(build({ senderIsOwner: false }));
    expect(nonOwner).not.toContain("gateway");
    expect(names(build({ senderIsOwner: true }))).toContain("gateway");
    // The tools that start another run stay; that run is marked non-owner.
    expect(nonOwner).toContain("sessions_spawn");
    expect(nonOwner).toContain("sessions_send");
  });

  it("the sub-agent a non-owner spawned is built without the money tools", () => {
    // sessions_spawn now sends senderIsOwner: false to the gateway `agent`
    // method, which hands it to the run.
    const child = names(
      build({
        sessionKey: "agent:main:subagent:11111111-2222-3333-4444-555555555555",
        senderIsOwner: false,
      }),
    );
    expect(child).not.toContain("wallet");
    expect(child).not.toContain("a2a_client");
    expect(child).not.toContain("gateway");
  });

  it("the cron turn a non-owner scheduled through a task wakeup carries the flag", () => {
    const params = buildIsolatedAgentTurnParams({
      message: "[long-horizon wakeup] Resume task t1.",
      sessionKey: "cron:task-wakeup-abc",
      agentId: "main",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      senderIsOwner: false,
    });
    expect(params.senderIsOwner).toBe(false);
    expect(validateAgentParams(params)).toBe(true);
    // A job the operator added has no flag and runs as before.
    const operator = buildIsolatedAgentTurnParams({
      message: "digest",
      sessionKey: "cron:daily",
      agentId: "main",
      idempotencyKey: "11111111-1111-4111-8111-111111111112",
    });
    expect(operator).not.toHaveProperty("senderIsOwner");
  });
});
