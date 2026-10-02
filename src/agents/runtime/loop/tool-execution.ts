/**
 * PLAN-52 Phase 2: tool execution for one assistant message.
 *
 * Port of the tool half of pi-agent-core 0.73.1's `agent-loop.js` (MIT, Mario
 * Zechner / pi-mono). Per call, in assistant source order:
 *
 *   tool_execution_start (raw arguments)
 *   -> tool lookup -> prepareArguments -> validateToolArguments (pi-ai)
 *   -> beforeToolCall -> execute -> afterToolCall
 *   -> tool_execution_end -> toolResult message_start / message_end
 *
 * A failure before `execute` (unknown tool, `prepareArguments` or validation
 * throw, hook throw, hook block, skip) gives an "immediate" error result:
 * `{ content: [{ type: "text", text }], details: {} }`, `isError: true`. The
 * tool is not executed and `afterToolCall` is not called.
 *
 * Deliberate differences from pi (1 to 3 are option-controlled and have a
 * differential test proving parity when switched off):
 *
 * 1. `toolExecution` defaults to "sequential" (pi: "parallel"). A tool with
 *    `executionMode: "sequential"` still forces a parallel batch sequential.
 * 2. `skipToolCallsOnSteering` (default true): while steering messages are
 *    queued, every call after the first of the assistant message gets the
 *    immediate result `STEERING_SKIP_REASON`. The check sits where
 *    `engines/pi/tool-loop-compat.ts` had it: after lookup and
 *    validation (an unknown tool or invalid arguments report their own
 *    error), before `beforeToolCall` (the hook is not called for a skipped
 *    call). It is a live check per call, and it does not drain the queue; the
 *    steering message is injected at the normal poll after the batch. "After
 *    the first" is the call's position in the message (the compat wrapper
 *    looked the id up, which differs only for duplicate tool call ids).
 * 3. `skipToolCallsOnAbort` (default true): a call that has not started when
 *    the signal is aborted gets the immediate result `ABORT_SKIP_REASON`. It
 *    is checked before anything else for the call, and again right before
 *    `execute` (the signal can abort during `beforeToolCall`, or in parallel
 *    mode while later calls are prepared). pi runs every remaining call with
 *    the aborted signal.
 * 4. Update events of a call are tracked so that a rejected emit (a listener
 *    that throws) cannot surface as an unhandled rejection while the tool is
 *    still running; the rejection still fails the run once the tool settles,
 *    as in pi. `onUpdate` calls made after `execute` settled are ignored (pi
 *    emits them with nobody awaiting the result, so a `tool_execution_update`
 *    can follow `tool_execution_end` or reach a later run).
 *
 * pi behaviour kept as is: `beforeToolCall` cannot rewrite the arguments;
 * `tool_execution_start` and `tool_execution_update` carry the raw arguments
 * while `execute` and the hooks get the validated ones; a tool that returns
 * no result object fails the run (the loop reads `result.content`).
 */
import {
  type AssistantMessage,
  type ToolResultMessage,
  validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentToolCall,
  AgentToolResult,
  AnyAgentTool,
} from "./events.js";
import { withEnumHints } from "./validation-hints.js";

/** Result text of a tool call skipped because a steering message is queued. */
export const STEERING_SKIP_REASON = "Skipped due to queued user message.";

/** Result text of a tool call that had not started when the run was aborted. */
export const ABORT_SKIP_REASON = "Aborted before execution.";

export type ExecutedToolCallBatch = {
  /** One tool result message per tool call, in assistant source order. */
  messages: ToolResultMessage[];
  /** True when every result of the batch set `terminate`. */
  terminate: boolean;
};

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AnyAgentTool;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<unknown>;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult<unknown>;
  isError: boolean;
};

type FinalizedToolCallOutcome = {
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function immediateError(message: string): ImmediateToolCallOutcome {
  return { kind: "immediate", result: createErrorToolResult(message), isError: true };
}

function abortedBeforeExecution(config: AgentLoopConfig, signal: AbortSignal | undefined): boolean {
  return config.skipToolCallsOnAbort !== false && signal?.aborted === true;
}

function skippedForSteering(config: AgentLoopConfig, index: number): boolean {
  return (
    config.skipToolCallsOnSteering !== false &&
    index > 0 &&
    config.hasQueuedSteeringMessages?.() === true
  );
}

/** Execute the tool calls of `assistantMessage` and emit their events. */
export async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(
    (block): block is AgentToolCall => block.type === "toolCall",
  );
  const hasSequentialToolCall = toolCalls.some(
    (toolCall) =>
      currentContext.tools?.find((tool) => tool.name === toolCall.name)?.executionMode ===
      "sequential",
  );
  if (config.toolExecution !== "parallel" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
  );
}

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      index,
      config,
      signal,
    );
    const finalized: FinalizedToolCallOutcome =
      preparation.kind === "immediate"
        ? { toolCall, result: preparation.result, isError: preparation.isError }
        : await runPreparedToolCall(
            currentContext,
            assistantMessage,
            preparation,
            config,
            signal,
            emit,
          );

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);

    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);
  }

  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      index,
      config,
      signal,
    );
    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCallOutcome = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      continue;
    }

    finalizedCalls.push(async () => {
      const finalized = await runPreparedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        config,
        signal,
        emit,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
  }

  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return { messages, terminate: shouldTerminateToolBatch(orderedFinalizedCalls) };
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every((finalized) => finalized.result.terminate === true)
  );
}

function prepareToolCallArguments(tool: AnyAgentTool, toolCall: AgentToolCall): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments: unknown = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as AgentToolCall["arguments"],
  };
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  index: number,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  if (abortedBeforeExecution(config, signal)) {
    return immediateError(ABORT_SKIP_REASON);
  }
  const tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return immediateError(`Tool ${toolCall.name} not found`);
  }

  try {
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    const validatedArgs: unknown = validateToolArguments(tool, preparedToolCall);
    if (skippedForSteering(config, index)) {
      return immediateError(STEERING_SKIP_REASON);
    }
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        { assistantMessage, toolCall, args: validatedArgs, context: currentContext },
        signal,
      );
      if (beforeResult?.block) {
        return immediateError(beforeResult.reason || "Tool execution was blocked");
      }
    }
    return { kind: "prepared", toolCall, tool, args: validatedArgs };
  } catch (error) {
    return immediateError(
      withEnumHints(errorMessageOf(error), tool.parameters, toolCall.arguments),
    );
  }
}

/** Execute and finalize a prepared call, unless the run was aborted meanwhile. */
async function runPreparedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
  if (abortedBeforeExecution(config, signal)) {
    return {
      toolCall: prepared.toolCall,
      result: createErrorToolResult(ABORT_SKIP_REASON),
      isError: true,
    };
  }
  const executed = await executePreparedToolCall(prepared, signal, emit);
  return finalizeExecutedToolCall(
    currentContext,
    assistantMessage,
    prepared,
    executed,
    config,
    signal,
  );
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let settled = false;

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as never,
      signal,
      (partialResult) => {
        if (settled) {
          return;
        }
        const emitted = Promise.resolve(
          emit({
            type: "tool_execution_update",
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            args: prepared.toolCall.arguments,
            partialResult,
          }),
        );
        // Mark as handled; `Promise.all` below still sees the rejection.
        void emitted.catch(() => undefined);
        updateEvents.push(emitted);
      },
    );
    settled = true;
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    settled = true;
    await Promise.all(updateEvents);
    return { result: createErrorToolResult(errorMessageOf(error)), isError: true };
  }
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(errorMessageOf(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content,
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}
