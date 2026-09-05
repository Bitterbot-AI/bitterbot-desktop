import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { checkRepeatedCall } from "./pi-tools.repeat-guard.js";
import { runInterceptors } from "./skills/interceptor-runner.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  let params = args.params;

  // PLAN-20: skill-owned interceptors run BEFORE plugin hooks so they can
  // shape the action surface plugins observe. Wrapped in try/catch — an
  // interceptor failure must never kill the tool call.
  try {
    const normalizedForInterceptors = isPlainObject(params)
      ? (params as Record<string, unknown>)
      : {};
    const interceptorOutcome = await runInterceptors({
      toolName,
      params: normalizedForInterceptors,
      sessionKey: args.ctx?.sessionKey,
      agentId: args.ctx?.agentId,
    });
    switch (interceptorOutcome.kind) {
      case "block": {
        // PLAN-20: structured block directive. If the interceptor set a
        // userVisibleMessage, wrap it in an `INTERCEPTOR-BLOCK:` envelope
        // so the agent surfaces the message verbatim and waits for user
        // confirmation rather than paraphrasing or burying the block
        // behind a generic error.
        const userMsg = interceptorOutcome.userVisibleMessage;
        const blockReason = userMsg
          ? [
              `INTERCEPTOR-BLOCK: ${userMsg}`,
              ``,
              `Display this message to the user verbatim. Do NOT retry the action`,
              `unless the user explicitly confirms ("yes", "do it", "proceed").`,
              ``,
              `(internal reason: ${interceptorOutcome.reason})`,
            ].join("\n")
          : `INTERCEPTOR-BLOCK: ${interceptorOutcome.reason}`;
        return { blocked: true, reason: blockReason };
      }
      case "modify":
        params = interceptorOutcome.params;
        break;
      case "require_prereq": {
        // PLAN-20: structured prereq message designed to be highly parseable
        // by the agent — instead of a generic error, the agent reads a
        // first-person directive that explicitly names the tool and args to
        // run before retrying. The tool dispatcher inside the embedded
        // runner shows this back as a tool-result message that the model
        // then conditions on.
        const args = JSON.stringify(interceptorOutcome.params);
        const directive = [
          `INTERCEPTOR: ${interceptorOutcome.reason}`,
          ``,
          `BEFORE you call \`${toolName}\` again, you MUST first call:`,
          `  tool: ${interceptorOutcome.tool}`,
          `  args: ${args}`,
          ``,
          `Then re-evaluate whether \`${toolName}\` still applies given the result of that call.`,
        ].join("\n");
        return {
          blocked: true,
          reason: directive,
        };
      }
      case "inject":
        // Inject-only interventions don't change params here; the runner
        // already persisted/emitted the record. Future: pipe through to
        // the working-memory context-injector.
        break;
      case "pass":
      default:
        break;
    }
  } catch (err) {
    log.warn(`interceptor stage threw: tool=${toolName} err=${String(err)}`);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // B6: refuse the (N+1)th identical failing call before any hook or
      // interceptor spends time on it. Deterministic; the error text is
      // what the model reads and what the journal records.
      const repeat = checkRepeatedCall({ scope: ctx?.sessionKey, toolName, args: params });
      if (repeat.blocked) {
        log.warn(`repeat guard blocked ${toolName} after ${repeat.failures} identical failures`);
        throw new Error(repeat.reason);
      }
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: false,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
