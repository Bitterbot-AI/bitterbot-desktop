import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import { resetRepeatGuardForTest } from "./pi-tools.repeat-guard.js";

function createContext() {
  const ctx = {
    params: {
      runId: "run-outcome",
      sessionKey: "agent:main:main",
      onBlockReplyFlush: vi.fn(),
      onAgentEvent: undefined,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: { debug: vi.fn(), warn: vi.fn() },
    state: {
      toolMetas: [] as Array<{ toolName: string; meta?: string }>,
      toolMetaById: new Map<string, unknown>(),
      toolSummaryById: new Set<string>(),
      lastToolError: undefined as unknown,
      pendingMessagingTargets: new Map<string, unknown>(),
      pendingMessagingTexts: new Map<string, string>(),
      messagingToolSentTexts: [] as string[],
      messagingToolSentTextsNormalized: [] as string[],
      messagingToolSentTargets: [] as unknown[],
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
  return ctx;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

describe("handleToolExecutionEnd journals body-level outcomes (B1)", () => {
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    for (const u of unsubscribes.splice(0)) u();
    resetRepeatGuardForTest();
  });

  async function run(result: unknown, isError = false) {
    const ctx = createContext();
    const seen: Array<Record<string, unknown>> = [];
    unsubscribes.push(
      onAgentEvent((evt) => {
        if (evt.runId === "run-outcome" && evt.stream === "tool" && evt.data.phase === "result") {
          seen.push(evt.data);
        }
      }),
    );
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "task_get",
        toolCallId: "c1",
        args: { task_id: "t" },
      } as never,
    );
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "task_get",
        toolCallId: "c1",
        isError,
        result,
      } as never,
    );
    return { ctx, event: seen[0]! };
  }

  it("records an {ok:false} body as a tool error, not a clean result", async () => {
    const { ctx, event } = await run(jsonResult({ ok: false, error: "task t not found" }));
    expect(event.isError).toBe(true);
    expect(event.outcome).toBe("error");
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "task_get",
      error: "task t not found",
    });
  });

  it("records approval-pending as pending (never success, never error)", async () => {
    const { ctx, event } = await run(jsonResult({ status: "approval-pending", approvalId: "a" }));
    expect(event.isError).toBe(false);
    expect(event.outcome).toBe("pending");
    expect(ctx.state.lastToolError).toBeUndefined();
  });

  it("keeps ok:true results as ok", async () => {
    const { event } = await run(jsonResult({ ok: true, task: { id: "t" } }));
    expect(event.isError).toBe(false);
    expect(event.outcome).toBe("ok");
  });
});
