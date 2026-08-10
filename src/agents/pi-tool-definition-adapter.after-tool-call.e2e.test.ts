import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

// Audit 2026-08-09 F2: after_tool_call was firing TWICE per embedded-runner
// tool call — once here in the adapter and once in the embedded-subscribe
// tool-end handler (pi-embedded-subscribe.handlers.tools.ts), which share the
// global hook runner. That double-recorded every skill_execution (5 of 10
// live rows were sub-1s duplicate pairs, one per pair with NULL duration
// because the adapter passed no durationMs) and double-dosed the hormonal
// reward/error signal on every tool call. The adapter is used ONLY inside the
// embedded runner (tool-split.ts → compact.ts), whose tool-end handler always
// fires after_tool_call with the full event. So the adapter must NOT fire it.
// The subscribe handler is the single owner.

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runAfterToolCall: vi.fn(async () => {}),
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn(() => undefined),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: hookMocks.consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook: hookMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

describe("pi tool definition adapter does NOT own after_tool_call (F2)", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(true); // hooks present but adapter must still not fire
    hookMocks.runner.runAfterToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReset();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockReset();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockReset();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("does NOT dispatch after_tool_call on successful execution (subscribe handler owns it)", async () => {
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-ok", { path: "/tmp/file" }, undefined, undefined);

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does NOT dispatch after_tool_call on error (subscribe handler sees the errorResult)", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err", { cmd: "ls" }, undefined, undefined);

    expect(result.details).toMatchObject({ status: "error", tool: "exec", error: "boom" });
    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("still consumes adjusted params for a before-hook-wrapped tool (no leak)", async () => {
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue({ mode: "safe" });
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute(
      "call-wrapped",
      { path: "/tmp/file" },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({ ok: true });
    // consumed exactly once so the per-call adjusted-params map does not leak
    expect(hookMocks.consumeAdjustedParamsForToolCall).toHaveBeenCalledWith("call-wrapped");
    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });
});
