/**
 * PLAN-52 Phase 2: the owned `Agent`.
 *
 * Port of pi-agent-core 0.73.1's `Agent` class (MIT, Mario Zechner /
 * pi-mono) with the same public surface: constructor options, `state`,
 * `subscribe`, `prompt`, `continue`, `steer`, `followUp`, `abort`,
 * `waitForIdle`, `reset`, the queue methods, and the writable fields that our
 * code and the session layer set (`streamFn`, `convertToLlm`,
 * `transformContext`, `getApiKey`, `onPayload`, `onResponse`,
 * `beforeToolCall`, `afterToolCall`, `toolExecution`, `steeringMode`,
 * `followUpMode`, `sessionId`, `thinkingBudgets`, `transport`,
 * `maxRetryDelayMs`).
 *
 * Deliberate differences from pi:
 *
 * 1. `toolExecution` defaults to "sequential" (pi: "parallel").
 * 2. `skipToolCallsOnSteering` (option and field, default true); see
 *    `agent-loop.ts`.
 * 3. `skipToolCallsOnAbort` (option and field, default true); see
 *    `agent-loop.ts`.
 * 4. `abortBeforeModelCall` (option and field, default true); see
 *    `agent-loop.ts`.
 * 5. `steeringQueue` / `followUpQueue` are public readonly (private in pi's
 *    typings, although the pi engine's compat wrapper read them), and
 *    `hasQueuedSteeringMessages()` is added.
 * 6. The failure message of a run gets its own zero-usage object (pi shares
 *    one module-level object between all failure messages).
 *
 * Snapshot semantics (same as pi; the session layer and the mid-turn budget
 * depend on them): `prompt()` / `continue()` capture the system prompt,
 * copies of `state.messages` and `state.tools`, the model, the thinking
 * level, `streamFn` and every option field once, at run start. Changing any
 * of them during a run affects the next run only. Assigning `state.messages`
 * during a run replaces the array later `message_end` events append to, but
 * not what the model sees in that run; use `transformContext` for that, it
 * is called before every model call.
 *
 * Other pi behaviour kept as is:
 *
 * - State is reduced before listeners run; listeners are awaited one by one
 *   in subscription order and are part of the run (`prompt()` resolves and
 *   `waitForIdle()` settles only after the `agent_end` listeners).
 * - A throw inside a run (stream function, `convertToLlm`,
 *   `transformContext`, `getApiKey`, a listener) does not reject `prompt()`:
 *   a synthetic assistant message (`stopReason` "error", or "aborted" if the
 *   run was aborted) is pushed to `state.messages` and only `agent_end` is
 *   emitted for it, without `message_start` / `message_end` / `turn_end`. A
 *   listener that throws on that `agent_end` does reject `prompt()`.
 * - `abort()` only aborts the signal. `reset()` does not abort a run.
 * - Queues are left as they are when a run ends on an error or abort.
 */
import {
  type Api,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
  type TextContent,
  type ThinkingBudgets,
  type Transport,
} from "@mariozechner/pi-ai";
import { createFailureMessage, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AnyAgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
  ToolExecutionMode,
} from "./events.js";
import { PendingMessageQueue, type QueueMode } from "./queues.js";

/** Listener for agent events. Receives the active run's abort signal. */
export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/** Options for constructing an `Agent`. */
export interface AgentOptions {
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
  /** Default: keep the messages with role user, assistant or toolResult. */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Default: pi-ai `streamSimple`. */
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  /** Default "one-at-a-time". */
  steeringMode?: QueueMode;
  /** Default "one-at-a-time". */
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  /** Default "auto". */
  transport?: Transport;
  maxRetryDelayMs?: number;
  /** Default "sequential" (pi: "parallel"). */
  toolExecution?: ToolExecutionMode;
  /** Not in pi. Default true. */
  skipToolCallsOnSteering?: boolean;
  /** Not in pi. Default true. */
  skipToolCallsOnAbort?: boolean;
  /** Not in pi. Default true. */
  abortBeforeModelCall?: boolean;
}

type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

const DEFAULT_MODEL: Model<Api> = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

function createMutableAgentState(initialState: AgentOptions["initialState"]): MutableAgentState {
  let tools: AnyAgentTool[] = initialState?.tools?.slice() ?? [];
  let messages: AgentMessage[] = initialState?.messages?.slice() ?? [];
  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    get tools(): AnyAgentTool[] {
      return tools;
    },
    set tools(nextTools: AnyAgentTool[]) {
      tools = nextTools.slice();
    },
    get messages(): AgentMessage[] {
      return messages;
    },
    set messages(nextMessages: AgentMessage[]) {
      messages = nextMessages.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

/**
 * Stateful wrapper around the loop: owns the transcript, the queues and the
 * run lifecycle, and fans events out to listeners.
 */
export class Agent {
  private readonly _state: MutableAgentState;
  private readonly listeners = new Set<AgentListener>();
  private activeRun: ActiveRun | undefined;

  readonly steeringQueue: PendingMessageQueue;
  readonly followUpQueue: PendingMessageQueue;

  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  /** Session identifier forwarded to the stream function. */
  sessionId?: string;
  /** Per-level thinking token budgets forwarded to the stream function. */
  thinkingBudgets?: ThinkingBudgets;
  /** Preferred transport forwarded to the stream function. */
  transport: Transport;
  /** Cap for provider-requested retry delays, forwarded to the stream function. */
  maxRetryDelayMs?: number;
  /** How the tool calls of one assistant message are executed. */
  toolExecution: ToolExecutionMode;
  /** Skip the rest of a tool batch once steering is queued. */
  skipToolCallsOnSteering: boolean;
  /** Do not start tool calls after the run was aborted. */
  skipToolCallsOnAbort: boolean;
  /** Do not call the stream function after the run was aborted. */
  abortBeforeModelCall: boolean;

  constructor(options: AgentOptions = {}) {
    this._state = createMutableAgentState(options.initialState);
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.streamFn = options.streamFn ?? streamSimple;
    this.getApiKey = options.getApiKey;
    this.onPayload = options.onPayload;
    this.onResponse = options.onResponse;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.transport = options.transport ?? "auto";
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "sequential";
    this.skipToolCallsOnSteering = options.skipToolCallsOnSteering ?? true;
    this.skipToolCallsOnAbort = options.skipToolCallsOnAbort ?? true;
    this.abortBeforeModelCall = options.abortBeforeModelCall ?? true;
  }

  /**
   * Subscribe to agent events. Listeners are awaited in subscription order
   * for every event and are part of the run's settlement. Returns the
   * unsubscribe function.
   */
  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current state. Assigning `state.tools` or `state.messages` stores a copy. */
  get state(): AgentState {
    return this._state;
  }

  /** How queued steering messages are drained. */
  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /** How queued follow-up messages are drained. */
  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /** Queue a message to inject after the current turn. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queue a message to run only when the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /** True when either queue holds a message. */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  /** True when the steering queue holds a message. Not in pi. */
  hasQueuedSteeringMessages(): boolean {
    return this.steeringQueue.hasItems();
  }

  /** Abort signal of the active run, if any. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the active run, if any. Emits nothing and clears nothing. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /** Resolves when the active run and its `agent_end` listeners are done. Never rejects. */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear the transcript, the runtime state and both queues. Does not abort. */
  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }

  /** Start a run from text, one message, or a batch of messages. */
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }

  /**
   * Continue from the current transcript. If the last message is an assistant
   * message, queued steering (else follow-up) messages are run as a prompt.
   */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this._state.messages[this._state.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new Error("Cannot continue from message role: assistant");
    }

    await this.runContinuation();
  }

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }
    if (typeof input !== "string") {
      return [input];
    }
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
    };
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this._state.model,
      reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      transport: this.transport,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      skipToolCallsOnSteering: this.skipToolCallsOnSteering,
      skipToolCallsOnAbort: this.skipToolCallsOnAbort,
      abortBeforeModelCall: this.abortBeforeModelCall,
      hasQueuedSteeringMessages: () => this.steeringQueue.hasItems(),
    };
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage = createFailureMessage(this._state.model, error, aborted);
    this._state.messages.push(failureMessage);
    this._state.errorMessage = failureMessage.errorMessage;
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  /** Reduce state for a loop event, then await the listeners. */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        this._state.streamingMessage = event.message;
        break;

      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._state.streamingMessage = undefined;
        break;

      default:
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
