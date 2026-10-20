/**
 * PLAN-52 Phase 2: the owned turn loop.
 *
 * Port of pi-agent-core 0.73.1's `agent-loop.js` (MIT, Mario Zechner /
 * pi-mono): stream an assistant response, execute its tool calls, append the
 * results, repeat until the model stops calling tools and both queues are
 * empty. With the four options below set to pi's behaviour the event
 * sequence and the resulting messages equal pi's
 * (`agent-loop.differential.test.ts`).
 *
 * Deliberate differences from pi (1 to 4 are option-controlled; details of
 * 1 to 3 in `tool-execution.ts`):
 *
 * 1. `toolExecution` defaults to "sequential" (pi: "parallel"). Per-tool
 *    `executionMode` is still honoured.
 * 2. `skipToolCallsOnSteering` (default true): once a steering message is
 *    queued, the remaining tool calls of the assistant message are not
 *    executed; each gets the error result "Skipped due to queued user
 *    message." through the normal tool_execution_start / tool_execution_end
 *    and message events. pi 0.73 runs the whole batch first. Needs
 *    `hasQueuedSteeringMessages` (set by `Agent`).
 * 3. `skipToolCallsOnAbort` (default true): a tool call that has not started
 *    when the signal is aborted is not executed; it gets the error result
 *    "Aborted before execution.". pi executes it with the aborted signal.
 * 4. `abortBeforeModelCall` (default true): when the signal is already
 *    aborted at a model call, the stream function is not called. The turn
 *    ends with a synthetic assistant message (`createFailureMessage`,
 *    `stopReason` "aborted", `errorMessage` `ABORTED_BEFORE_MODEL_CALL`)
 *    through the events an aborted provider response gives: `message_start`,
 *    `message_end`, `turn_end`, then `agent_end`. The signal is checked
 *    twice: before `transformContext` / `convertToLlm` / `getApiKey` (none of
 *    them runs for an aborted run), and again right before the stream
 *    function call (an abort during those three). pi calls the stream
 *    function with the aborted signal and relies on it to report the abort,
 *    so a stream function that ignores the signal continues the run.
 * 5. A response stream that ends without a `done` or `error` event and
 *    without a result ends the turn with a synthetic assistant message
 *    (`stopReason` "error", or "aborted" if the signal is aborted;
 *    `errorMessage` `STREAM_ENDED_MESSAGE`; partial content kept). pi awaits
 *    `response.result()` forever in that case.
 * 6. `agentLoop` / `agentLoopContinue` end their stream with a synthetic
 *    failure message when the loop rejects. pi leaves the stream open and the
 *    rejection unhandled.
 * 7. Tool update events: see `tool-execution.ts`, difference 4.
 *
 * Semantics the rest of the runtime depends on (same as pi):
 *
 * - Snapshot. The loop works on the `context` it is given and never reads
 *   agent state. `Agent` passes copies of `state.messages` and `state.tools`
 *   taken at run start, so assigning `state.messages`, `state.tools`,
 *   `state.systemPrompt`, `state.model` or any `Agent` option during a run
 *   affects the next run only. The run's own messages (prompts, steering,
 *   assistant, tool results) are appended to the snapshot.
 * - `transformContext` is called before every model call with the run's
 *   messages; its result is used for that call only and is not written back.
 *   `convertToLlm` and `getApiKey` are also called before every model call.
 *   This is the seam for changing what the model sees mid-run.
 * - `message_end` carries the object that is stored in the context (and, via
 *   `Agent`, in `state.messages`); `message_start` and `message_update` of an
 *   assistant message carry shallow copies of the partial.
 * - Steering is polled before the first model call and after every turn
 *   (after the whole tool batch); follow-ups only when the run would
 *   otherwise stop. Neither queue is polled when a run ends on an error or
 *   aborted assistant message.
 * - Tool calls are executed for any `stopReason` except "error" and
 *   "aborted" (so also for "length").
 *
 * pi behaviour kept as is:
 *
 * - Apart from differences 3 and 4 the loop does not look at the signal. An
 *   abort while a response is streaming is the stream function's to report
 *   (an `error` event with `stopReason` "aborted").
 * - The whole loop config (hooks and queue callbacks included) is spread
 *   into the options passed to the stream function.
 * - Assistant stream events other than `start` are dropped until a `start`
 *   event was seen.
 * - A throw from `transformContext`, `convertToLlm`, `getApiKey`, the stream
 *   function or `emit` rejects the loop without `turn_end` / `agent_end`
 *   (`Agent` turns that into a synthetic failure message).
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  EventStream,
  type Model,
  streamSimple,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from "./events.js";
import { executeToolCalls } from "./tool-execution.js";

/**
 * `errorMessage` of the synthetic message for difference 4. Same text as
 * pi-ai's providers report for an aborted request.
 */
export const ABORTED_BEFORE_MODEL_CALL = "Request was aborted";

/** `errorMessage` of the synthetic message for difference 5. */
export const STREAM_ENDED_MESSAGE = "Stream ended without a final message";

/**
 * How long to wait for `result()` after a stream's iterator ended without a
 * terminal event. pi-ai's stream resolves it before the iterator ends or
 * never; the grace period only covers other stream implementations.
 */
const STREAM_RESULT_GRACE_MS = 100;

/**
 * The assistant message that stands in for a run or turn that failed outside
 * the model stream. Same shape as pi's `Agent.handleRunFailure` message.
 */
export function createFailureMessage(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

/**
 * Run the loop for new prompt messages and return its events as a stream.
 * The stream's result is the list of messages the run added.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  pumpAgentStream(
    stream,
    runAgentLoop(
      prompts,
      context,
      config,
      (event) => {
        stream.push(event);
      },
      signal,
      streamFn,
    ),
    config,
    signal,
  );
  return stream;
}

/**
 * Like `agentLoop`, without new messages. The last context message must not
 * be an assistant message (throws synchronously otherwise).
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  assertCanContinue(context);
  const stream = createAgentStream();
  pumpAgentStream(
    stream,
    runAgentLoopContinue(
      context,
      config,
      (event) => {
        stream.push(event);
      },
      signal,
      streamFn,
    ),
    config,
    signal,
  );
  return stream;
}

/**
 * Run the loop for new prompt messages. `context` is not mutated; the loop
 * works on a copy of `context.messages` with `prompts` appended. Returns the
 * messages the run added (prompts included).
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/**
 * Run the loop from the current context without new messages. As in pi, the
 * run's messages are appended to `context.messages` itself (the array is not
 * copied here; `Agent` passes a copy). Returns the messages the run added.
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  assertCanContinue(context);

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

function assertCanContinue(context: AgentContext): void {
  const lastMessage = context.messages[context.messages.length - 1];
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}

function pumpAgentStream(
  stream: EventStream<AgentEvent, AgentMessage[]>,
  run: Promise<AgentMessage[]>,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): void {
  void run.then(
    (messages) => {
      stream.end(messages);
    },
    (error: unknown) => {
      const failure = createFailureMessage(config.model, error, signal?.aborted === true);
      stream.push({ type: "agent_end", messages: [failure] });
      stream.end([failure]);
    },
  );
}

/** Loop body shared by `runAgentLoop` and `runAgentLoopContinue`. */
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn | undefined,
): Promise<void> {
  let firstTurn = true;
  // Steering queued before the run started goes in front of the first model call.
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // Outer loop: runs again when follow-up messages arrive after the run would stop.
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: one iteration per turn (model call plus its tool batch).
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Inject queued messages before the next assistant response.
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const hasToolCalls = message.content.some((block) => block.type === "toolCall");
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (hasToolCalls) {
        const executedToolBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
        );
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      if (
        await config.shouldStopAfterTurn?.({
          message,
          toolResults,
          context: currentContext,
          newMessages,
        })
      ) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // The run would stop here. Follow-ups start another turn.
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * One model call. AgentMessage[] becomes LLM messages only here
 * (`transformContext`, then `convertToLlm`).
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn | undefined,
): Promise<AssistantMessage> {
  if (abortedBeforeModelCall(config, signal)) {
    return finishAbortedBeforeModelCall(context, config, emit);
  }

  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction: StreamFn = streamFn || streamSimple;

  // Resolved per call so that short-lived tokens can be refreshed mid-run.
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  // The signal can abort while the context is prepared.
  if (abortedBeforeModelCall(config, signal)) {
    return finishAbortedBeforeModelCall(context, config, emit);
  }

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        return finishAssistantMessage(context, finalMessage, addedPartial, emit);
      }
    }
  }

  const finalMessage = await resultAfterStreamEnd(response, partialMessage, config, signal);
  return finishAssistantMessage(context, finalMessage, addedPartial, emit);
}

function abortedBeforeModelCall(config: AgentLoopConfig, signal: AbortSignal | undefined): boolean {
  return config.abortBeforeModelCall !== false && signal?.aborted === true;
}

/** End the turn without a model call (difference 4). */
function finishAbortedBeforeModelCall(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  const message = createFailureMessage(config.model, ABORTED_BEFORE_MODEL_CALL, true);
  return finishAssistantMessage(context, message, false, emit);
}

/** Store the final message in the context and emit its closing events. */
async function finishAssistantMessage(
  context: AgentContext,
  finalMessage: AssistantMessage,
  addedPartial: boolean,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

/**
 * The stream's iterator ended without a `done` or `error` event. Use the
 * stream's result if it has one (`end(result)`), else build an error message
 * from the last partial (difference 5).
 */
async function resultAfterStreamEnd(
  response: AssistantMessageEventStream,
  partialMessage: AssistantMessage | null,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gracePeriod = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), STREAM_RESULT_GRACE_MS);
  });
  try {
    const result = await Promise.race([response.result(), gracePeriod]);
    if (result) {
      return result;
    }
  } finally {
    clearTimeout(timer);
  }

  const aborted = signal?.aborted === true;
  const failure = createFailureMessage(config.model, STREAM_ENDED_MESSAGE, aborted);
  if (!partialMessage) {
    return failure;
  }
  return {
    ...partialMessage,
    stopReason: failure.stopReason,
    errorMessage: failure.errorMessage,
  };
}
