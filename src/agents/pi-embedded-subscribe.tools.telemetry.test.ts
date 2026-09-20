import { describe, expect, it } from "vitest";
import {
  classifyToolErrorClass,
  createToolCallTelemetry,
  extractNativeToolSearchCalls,
  measureToolResult,
  type ToolCallTelemetryEvent,
} from "./pi-embedded-subscribe.tools.js";

function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}

describe("tool-call telemetry tap", () => {
  it("records direct, use_tool (with the dispatched target), list_tools and failures", () => {
    const rows: ToolCallTelemetryEvent[] = [];
    let clock = 1_000;
    const tap = createToolCallTelemetry((e) => rows.push(e), { now: () => clock });

    tap.onEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "a" },
    });
    clock += 40;
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      result: text("hello"),
    });

    tap.onEvent({
      type: "tool_execution_start",
      toolCallId: "c2",
      toolName: "use_tool",
      args: { name: "browser", args: {} },
    });
    clock += 250;
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "use_tool",
      isError: false,
      result: {
        content: [{ type: "text", text: '{"ok":false,"error":"request timed out after 30s"}' }],
      },
    });

    tap.onEvent({
      type: "tool_execution_start",
      toolCallId: "c3",
      toolName: "list_tools",
      args: {},
    });
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "c3",
      toolName: "list_tools",
      isError: false,
      result: text("browser, canvas"),
    });

    tap.onEvent({ type: "tool_execution_start", toolCallId: "c4", toolName: "exec", args: {} });
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "c4",
      toolName: "exec",
      isError: true,
      result: text("permission denied by policy"),
    });
    // Unrelated events are ignored; an end without a start still records.
    tap.onEvent({ type: "message_end", message: {} });
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "c5",
      toolName: "read",
      isError: false,
      result: text("x"),
    });

    expect(rows.map((r) => [r.tool, r.via, r.ok, r.errorClass, r.durationMs])).toEqual([
      ["read", "direct", true, undefined, 40],
      ["browser", "use_tool", false, "timeout", 250],
      ["list_tools", "list_tools", true, undefined, 0],
      ["exec", "direct", false, "denied", 0],
      ["read", "direct", true, undefined, undefined],
    ]);
    expect(rows[0]?.resultChars).toBe(5);
    expect(rows[0]?.spilled).toBe(false);
  });

  it("detects spilled results from the marker and reports the original size", () => {
    const spilled = `head\n[truncated: 123456 chars total; full output saved to /tmp/x-1.txt; use read to view]\ntail`;
    expect(measureToolResult(text(spilled))).toEqual({ chars: 123456, spilled: true });
    expect(measureToolResult(text("small"))).toEqual({ chars: 5, spilled: false });
    expect(
      measureToolResult({ content: [{ type: "text", text: "s" }], details: { spilled: true } }),
    ).toEqual({
      chars: 1,
      spilled: true,
    });
    const rows: ToolCallTelemetryEvent[] = [];
    const tap = createToolCallTelemetry((e) => rows.push(e));
    tap.onEvent({ type: "tool_execution_start", toolCallId: "s", toolName: "exec", args: {} });
    tap.onEvent({
      type: "tool_execution_end",
      toolCallId: "s",
      toolName: "exec",
      isError: false,
      result: text(spilled),
    });
    expect(rows[0]).toMatchObject({ tool: "exec", spilled: true, resultChars: 123456, ok: true });
  });

  it("classifies error messages into coarse classes", () => {
    expect(classifyToolErrorClass(undefined)).toBe("error");
    expect(classifyToolErrorClass("Tool not found: foo")).toBe("not-found");
    expect(classifyToolErrorClass("invalid arguments: missing required field")).toBe(
      "invalid-args",
    );
    expect(classifyToolErrorClass("429 rate limit exceeded")).toBe("rate-limit");
    expect(classifyToolErrorClass("fetch failed: ECONNRESET")).toBe("network");
    expect(classifyToolErrorClass("boom")).toBe("error");
  });

  it("records native tool search from server_tool_use blocks, one row per tool_reference", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "tool_search_tool_regex",
          input: { query: "wallet" },
        },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            { type: "tool_reference", tool_name: "wallet" },
            { type: "tool_reference", tool_name: "send_usdc" },
          ],
        },
        {
          type: "server_tool_use",
          id: "srvtoolu_2",
          name: "tool_search_tool_bm25",
          input: { query: "nothing" },
        },
        { type: "tool_search_tool_result", tool_use_id: "srvtoolu_2", content: [] },
        { type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: {} },
      ],
    };
    const rows = extractNativeToolSearchCalls(message, 5);
    expect(rows.map((r) => [r.tool, r.via, r.ok])).toEqual([
      ["wallet", "native-search", true],
      ["send_usdc", "native-search", true],
      ["tool_search_tool_bm25", "native-search", true],
    ]);
    const captured: ToolCallTelemetryEvent[] = [];
    const tap = createToolCallTelemetry((e) => captured.push(e));
    tap.onAssistantMessage(message);
    tap.onAssistantMessage({ role: "assistant", content: [{ type: "text", text: "plain" }] });
    tap.onAssistantMessage(undefined);
    expect(captured).toHaveLength(3);
  });

  it("never lets a throwing sink affect the caller", () => {
    const tap = createToolCallTelemetry(() => {
      throw new Error("ledger down");
    });
    expect(() => {
      tap.onEvent({ type: "tool_execution_start", toolCallId: "x", toolName: "read", args: {} });
      tap.onEvent({
        type: "tool_execution_end",
        toolCallId: "x",
        toolName: "read",
        isError: false,
        result: text("a"),
      });
    }).not.toThrow();
  });
});
