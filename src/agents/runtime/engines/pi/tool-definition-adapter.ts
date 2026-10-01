import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { logDebug, logError } from "../../../../logger.js";
import { isPlainObject } from "../../../../utils.js";
import {
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../../../agent-tools.before-tool-call.js";
import type { ClientToolDefinition } from "../../../embedded-runner/run/params.js";
import { toPlainJsonSchema } from "../../../schema/plain-json-schema.js";
import { normalizeToolName } from "../../../tool-policy.js";
import { jsonResult } from "../../../tools/common.js";

// oxlint-disable-next-line typescript/no-explicit-any
type AnyAgentTool = AgentTool<any, unknown>;

// pi-coding-agent >= 0.73 calls ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx).
type ToolExecuteArgs = Parameters<ToolDefinition["execute"]>;

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: toPlainJsonSchema(tool.parameters),
      // Argument shims (e.g. pi's edit tool folding legacy oldText/newText into
      // edits[]) run before validation and must survive the conversion.
      ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
      ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const [toolCallId, params, signal, onUpdate] = args;
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }
          const result = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          // NOTE: after_tool_call is intentionally NOT fired here. This adapter
          // is used only inside the embedded runner (tool-split.ts →
          // compact.ts), whose tool-end handler
          // (embedded-subscribe.handlers.tools.ts) already fires
          // after_tool_call with the full event (durationMs, sanitized result).
          // Firing it here too double-recorded every skill_execution and
          // double-dosed the hormonal reward/error signal on every tool call
          // (audit 2026-08-09, F2). The subscribe handler is the single owner.
          if (beforeHookWrapped) {
            consumeAdjustedParamsForToolCall(toolCallId);
          }

          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          if (beforeHookWrapped) {
            consumeAdjustedParamsForToolCall(toolCallId);
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          const errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });

          // after_tool_call NOT fired here either (see success-path note): the
          // adapter returns errorResult rather than throwing, so the embedded
          // runner's tool-end handler still fires after_tool_call with
          // isToolError detected from this result. Single owner = subscribe
          // handler (audit 2026-08-09, F2).
          return errorResult;
        }
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: { agentId?: string; sessionKey?: string },
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      // oxlint-disable-next-line typescript/no-explicit-any
      parameters: func.parameters as any,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const [toolCallId, params] = args;
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
