/**
 * PLAN-52 Phase 2: event, message, tool and config types of the owned agent
 * loop.
 *
 * These mirror `@mariozechner/pi-agent-core` 0.73.1 `types.d.ts` (MIT, Mario
 * Zechner / pi-mono) name for name and field for field, so the consumers of
 * today's `AgentEvent` (the embedded-subscribe handlers) and of `AgentTool`
 * keep working when the import path changes. Message, model and stream types
 * come from pi-ai, which stays a dependency.
 *
 * Differences from pi's declarations:
 *
 * 1. `any` is replaced by `unknown` where the loop only passes a value
 *    through (`args`, `result`, `partialResult`, tool `details`). The types
 *    stay mutually assignable with pi's.
 * 2. `AgentLoopConfig` has four extra optional fields
 *    (`skipToolCallsOnSteering`, `skipToolCallsOnAbort`,
 *    `abortBeforeModelCall`, `hasQueuedSteeringMessages`); see
 *    `agent-loop.ts`.
 * 3. `CustomAgentMessages` is our own interface. pi-coding-agent's custom
 *    roles are merged into pi's interface, not this one, so the session layer
 *    (Phase 3) has to merge its custom message types here.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  Static,
  streamSimple,
  TextContent,
  Tool,
  ToolResultMessage,
  TSchema,
} from "@mariozechner/pi-ai";

/**
 * Stream function used by the loop. Same contract as pi: request, model and
 * runtime failures are reported in the returned stream (a final assistant
 * message with `stopReason` "error" or "aborted" and `errorMessage`), not by
 * throwing. A throw is still handled: it ends the run with a synthetic
 * failure message (see `Agent`).
 */
export type StreamFn = (
  ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * How the tool calls of one assistant message are executed.
 *
 * - "sequential": each call is prepared, executed and finalized before the
 *   next one starts.
 * - "parallel": calls are prepared one by one, then the allowed ones execute
 *   concurrently. `tool_execution_end` is emitted in completion order; the
 *   tool result messages are emitted afterwards in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** A tool call block of an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Returned by `beforeToolCall`. `{ block: true }` prevents execution. */
export interface BeforeToolCallResult {
  block?: boolean;
  /** Text of the error tool result. Default "Tool execution was blocked". */
  reason?: string;
}

/**
 * Partial override returned by `afterToolCall`. Field-wise replacement, no
 * deep merge; omitted fields keep the executed values.
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  /** See `AgentToolResult.terminate`. */
  terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Arguments after `prepareArguments` and schema validation. */
  args: unknown;
  /** The run's context at the time the call is prepared. */
  context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Arguments after `prepareArguments` and schema validation. */
  args: unknown;
  /** The executed result, before any override. */
  result: AgentToolResult<unknown>;
  /** Whether the executed result counts as an error. */
  isError: boolean;
  /** The run's context at the time the call is finalized. */
  context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
  /** The assistant message that completed the turn. */
  message: AssistantMessage;
  /** The tool results passed to the preceding `turn_end` event. */
  toolResults: ToolResultMessage[];
  /** The run's context after the turn's messages were appended. */
  context: AgentContext;
  /** The messages this loop invocation returns if it exits here. */
  newMessages: AgentMessage[];
}

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<Api>;
  /** AgentMessage[] to LLM messages, called before every model call. */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /**
   * Applied to the run's messages before `convertToLlm`, before every model
   * call. The result is used for that call only; it does not replace the
   * run's context.
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Resolves an API key before every model call. Falls back to `apiKey`. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /**
   * Called after `turn_end`. Returning true emits `agent_end` and exits
   * before the steering and follow-up queues are polled.
   */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  /**
   * Returns (and removes) the steering messages to inject before the next
   * model call. Polled once before the first model call and after every turn.
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /**
   * Returns (and removes) follow-up messages. Polled only when the run would
   * otherwise stop (no tool calls, no steering).
   */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /** Default "sequential" (pi: "parallel"). */
  toolExecution?: ToolExecutionMode;
  /** Called after validation, before execution. */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  /** Called after execution, before `tool_execution_end`. */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  /**
   * Not in pi. Non-draining check for queued steering messages, used by the
   * steering skip. Without it nothing is skipped for steering.
   */
  hasQueuedSteeringMessages?: () => boolean;
  /**
   * Not in pi. Default true: once steering is queued, the tool calls after
   * the first one of an assistant message get an error result
   * ("Skipped due to queued user message.") instead of running.
   */
  skipToolCallsOnSteering?: boolean;
  /**
   * Not in pi. Default true: a tool call that has not started when the signal
   * is aborted gets an error result ("Aborted before execution.") instead of
   * running.
   */
  skipToolCallsOnAbort?: boolean;
  /**
   * Not in pi. Default true: when the signal is already aborted at a model
   * call, the stream function is not called and the turn ends with a
   * synthetic "aborted" assistant message.
   */
  abortBeforeModelCall?: boolean;
}

/** Reasoning level requested for future turns. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Extension point for app-specific message roles, by declaration merging on
 * this module (same mechanism as pi's interface of the same name).
 */
export interface CustomAgentMessages {}

/**
 * LLM messages plus app-specific ones. The loop only looks at `role`; custom
 * roles reach the model through `convertToLlm`. The second constituent is
 * `never` until `CustomAgentMessages` is merged.
 */
// oxlint-disable-next-line typescript/no-redundant-type-constituents
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
  /** Content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Structured details for logs or UI. */
  details: T;
  /**
   * Hint to stop after the current tool batch. The run stops only when every
   * result of the batch sets it.
   */
  terminate?: boolean;
}

/** Callback a tool uses to report partial results while it runs. */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the loop. */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> extends Tool<TParameters> {
  /** Label for UI display. */
  label: string;
  /** Optional shim applied to the raw arguments before schema validation. */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Execute the call. Throw on failure. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /**
   * Per-tool override. One "sequential" tool in a batch makes the whole batch
   * sequential.
   */
  executionMode?: ToolExecutionMode;
}

/**
 * A tool with any parameter schema. `any` is needed here: `execute` takes the
 * parameters contravariantly, so no other type argument accepts every tool.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

/** Context the loop works on. `Agent` passes a snapshot taken at run start. */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AnyAgentTool[];
}

/**
 * Public agent state. Assigning `tools` or `messages` stores a copy of the
 * top-level array; the getter returns the live internal array.
 */
export interface AgentState {
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Model used for future runs. */
  model: Model<Api>;
  /** Reasoning level for future runs. */
  thinkingLevel: ThinkingLevel;
  tools: AnyAgentTool[];
  messages: AgentMessage[];
  /** True from run start until the `agent_end` listeners have settled. */
  readonly isStreaming: boolean;
  /** Partial assistant message of the response being streamed, if any. */
  readonly streamingMessage?: AgentMessage;
  /** Ids of the tool calls currently executing. Replaced on every change. */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** Error message of the most recent failed or aborted assistant turn. */
  readonly errorMessage?: string;
}

/**
 * Events emitted by the loop. `agent_end` is the last event of a run; the
 * agent is idle only after its listeners have settled.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AgentMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

/** Receives the loop's events. A rejected promise aborts the loop. */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
