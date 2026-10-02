/**
 * PLAN-52 Phase 3: the owned agent session.
 *
 * It replaces pi-coding-agent's `AgentSession` + `createAgentSession` for the
 * "bitterbot" engine: it wires the owned loop (`../loop`) to a transcript
 * store, persists messages, retries transient provider errors, and compacts
 * through a `CompactionPolicy`. The public surface is the subset of pi's
 * session that the embedded runner and its subscriber use, with the same
 * event names and payloads, so both engines can sit behind one call site.
 *
 * Behaviour is ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner /
 * pi-mono): event processing and persistence order, the retry rule and its
 * regex, the threshold and overflow compaction checks, the restore rules at
 * creation. The runtime contract suite compares the two engines event for
 * event.
 *
 * Deliberate differences from pi:
 * 1. No extension runner, resource loader, skill or prompt-template
 *    expansion, and no settings files. Nothing is read from the workspace.
 * 2. One settable `systemPrompt`; it is not rebuilt per prompt or per tool
 *    change.
 * 3. `prompt()` resolves only when the session has settled: the event queue
 *    is drained (every message is persisted) and any retry or post-compaction
 *    run has finished. pi resolves before an overflow recovery completes.
 * 4. A retry wait can no longer hang when a run fails without producing an
 *    assistant message.
 * 5. `abort()` also cancels a scheduled retry or post-compaction run.
 * 6. A listener that throws does not stop the event from being persisted.
 * 7. Auto-compaction does not require an API key (pi silently skips it for
 *    keyless providers); it requires only that request auth resolves.
 * 8. The compaction summary is requested through the session's stream
 *    function, so the same provider path, auth, and accounting apply as for
 *    turns. pi calls the provider directly.
 * 9. Nothing starts or is written after a stop: `abort()` also aborts an
 *    auto-compaction in flight, a prompt that is still in its preflight when
 *    `abort()` or `dispose()` is called does not start a run, a cancelled
 *    retry is not followed by a compaction check, and a disposed session
 *    writes no compaction entry. pi can start a run, call the model, and
 *    append to the transcript after the caller has torn the session down.
 * 10. A transcript write that fails is reported (`onPersistenceError`) and
 *    makes `prompt()` reject; pi drops the error and the turn looks fine.
 * 11. After a compaction that precedes a retry, every trailing errored
 *    assistant message is dropped from the context, not only the last one
 *    (a retried 429 followed by an overflow left pi unable to continue).
 * 12. The failure reported by `agent_end` wins over an older assistant
 *    message when deciding to retry, so a stream function that throws on a
 *    later turn of a run is retried as on the first.
 */

import {
  type Api,
  type AssistantMessage,
  clampThinkingLevel,
  cleanupSessionResources,
  type ImageContent,
  isContextOverflow,
  type Model,
  streamSimple,
  type TextContent,
} from "@mariozechner/pi-ai";
import {
  type CompactionOutcome,
  type CompactionPolicy,
  type CompactionReason,
  type CompactionSettings,
  isStubsOnly,
} from "../compaction/policy.js";
import { createSummaryCompactionPolicy } from "../compaction/summary-policy.js";
import {
  calculateContextTokens,
  convertToLlm,
  estimateContextTokens,
  type SessionMessage,
} from "../compaction/summary/index.js";
import {
  applyStubsToMessages,
  buildPruneRecordData,
  collectStubRecords,
  PRUNE_RECORD_CUSTOM_TYPE,
  type ToolOutputStub,
} from "../context-pruning/offload-stubs.js";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AnyAgentTool,
  type QueueMode,
  type StreamFn,
  type ThinkingLevel,
} from "../loop/index.js";
import type { SessionContext, TranscriptEntry, TranscriptMessage } from "../transcript/types.js";

export type RetrySettings = { enabled: boolean; maxRetries: number; baseDelayMs: number };

export type SessionSettings = {
  retry: RetrySettings;
  compaction: CompactionSettings;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  /** Replace images in user and tool-result messages with a text note. */
  blockImages: boolean;
};

/** pi-coding-agent 0.73.1 defaults. */
export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  blockImages: false,
};

export type RequestAuthResult =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

/** The transcript store surface the session uses (TranscriptStore or pi's SessionManager). */
export type SessionStore = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getBranch(): TranscriptEntry[];
  getEntries(): TranscriptEntry[];
  buildSessionContext(): SessionContext;
  appendMessage(message: TranscriptMessage): string;
  appendCustomMessageEntry(
    customType: string,
    content: unknown,
    display: boolean,
    details?: unknown,
  ): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string;
  appendModelChange(provider: string, modelId: string): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
};

export type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      result: CompactionOutcome | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export type AgentSessionListener = (event: AgentSessionEvent) => void;

export type AgentSessionOptions = {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  /** Tools in the order they are sent to the model. */
  tools: AnyAgentTool[];
  store: SessionStore;
  settings?: {
    retry?: Partial<RetrySettings>;
    compaction?: Partial<CompactionSettings>;
    steeringMode?: QueueMode;
    followUpMode?: QueueMode;
    blockImages?: boolean;
  };
  /** Stream function for turns and compaction summaries. Default: pi-ai `streamSimple`. */
  streamFn?: StreamFn;
  /**
   * Key and headers for a model. Used by compaction and by the prompt
   * preflight. When omitted, auth is whatever the stream function resolves.
   */
  resolveRequestAuth?: (model: Model<Api>) => Promise<RequestAuthResult>;
  /** Default: the summary policy (pi's behaviour). */
  compactionPolicy?: CompactionPolicy;
  /** Called when a listener throws; the event is still persisted. */
  onListenerError?: (error: unknown, event: AgentSessionEvent) => void;
  /** Called when a message could not be written to the transcript. */
  onPersistenceError?: (error: unknown) => void;
};

/** Transient provider errors worth a retry (pi-coding-agent 0.73.1, verbatim). */
const RETRYABLE_ERROR =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

const OVERFLOW_RETRY_FAILED =
  "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

const BUSY_MESSAGE =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

const IMAGES_DISABLED = "Image reading is disabled.";

function isAssistant(message: AgentMessage | undefined): message is AssistantMessage {
  return (message as { role?: string } | undefined)?.role === "assistant";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The error `prompt()` rejects with when the session was stopped before the run started. */
function abortedBeforeStart(): Error {
  const error = new Error("The run was aborted before it started");
  error.name = "AbortError";
  return error;
}

/**
 * One tool per name, as pi's registry (a Map keyed by name) had it: a later
 * definition replaces an earlier one and keeps the earlier one's position.
 * A client tool therefore shadows a server tool of the same name, and the
 * model is never sent two tools with one name.
 */
export function dedupeToolsByName(tools: readonly AnyAgentTool[]): AnyAgentTool[] {
  const byName = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }
  return [...byName.values()];
}

function latestCompactionEntry(
  entries: TranscriptEntry[],
): Extract<TranscriptEntry, { type: "compaction" }> | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "compaction") {
      return entry;
    }
  }
  return null;
}

export class AgentSession {
  readonly agent: Agent;
  /** The transcript store. Named as on pi's session; the subscriber reaches it by this name. */
  readonly sessionManager: SessionStore;

  private readonly settings: SessionSettings;
  private readonly policy: CompactionPolicy;
  private readonly resolveRequestAuth?: (model: Model<Api>) => Promise<RequestAuthResult>;
  private readonly onListenerError?: (error: unknown, event: AgentSessionEvent) => void;
  private readonly onPersistenceError?: (error: unknown) => void;

  private listeners: AgentSessionListener[] = [];
  private unsubscribeAgent: (() => void) | undefined;
  private eventQueue: Promise<void> = Promise.resolve();
  private steeringMessages: string[] = [];
  private followUpMessages: string[] = [];
  private lastAssistantMessage: AssistantMessage | undefined;
  private retryAttempt = 0;
  private retryPromise: Promise<void> | undefined;
  private retryResolve: (() => void) | undefined;
  private retryAbort: AbortController | undefined;
  private overflowRecoveryAttempted = false;
  private manualCompactionAbort: AbortController | undefined;
  private autoCompactionAbort: AbortController | undefined;
  /** Runs scheduled after a retry delay or a compaction; `prompt()` waits for them. */
  private scheduled = new Set<{ promise: Promise<void>; cancel: () => void }>();
  private disposed = false;
  /** Incremented by every abort() and dispose(); a prompt in preflight compares it. */
  private stopEpoch = 0;
  /** abort() calls that have not resolved yet. */
  private abortsInFlight = 0;
  /** First transcript write failure of the current prompt. */
  private persistenceError: unknown;

  constructor(options: AgentSessionOptions) {
    this.sessionManager = options.store;
    this.settings = {
      retry: { ...DEFAULT_SESSION_SETTINGS.retry, ...options.settings?.retry },
      compaction: { ...DEFAULT_SESSION_SETTINGS.compaction, ...options.settings?.compaction },
      steeringMode: options.settings?.steeringMode ?? DEFAULT_SESSION_SETTINGS.steeringMode,
      followUpMode: options.settings?.followUpMode ?? DEFAULT_SESSION_SETTINGS.followUpMode,
      blockImages: options.settings?.blockImages ?? DEFAULT_SESSION_SETTINGS.blockImages,
    };
    this.policy = options.compactionPolicy ?? createSummaryCompactionPolicy();
    this.resolveRequestAuth = options.resolveRequestAuth;
    this.onListenerError = options.onListenerError;
    this.onPersistenceError = options.onPersistenceError;

    // As pi: a level the model does not support is moved to the nearest one it does.
    const thinkingLevel = clampThinkingLevel(
      options.model,
      options.thinkingLevel ?? "off",
    ) as ThinkingLevel;
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel,
        tools: dedupeToolsByName(options.tools),
      },
      convertToLlm: (messages) => this.convertToLlm(messages),
      streamFn: options.streamFn ?? streamSimple,
      sessionId: options.store.getSessionId(),
      steeringMode: this.settings.steeringMode,
      followUpMode: this.settings.followUpMode,
    });

    // Restore, as pi's createAgentSession does: an existing transcript gives
    // the messages (and gains a thinking-level entry only if it has none); a
    // new one records the model and the thinking level first.
    const existing = options.store.buildSessionContext();
    if (existing.messages.length > 0) {
      this.agent.state.messages = existing.messages as unknown as AgentMessage[];
      const hasThinkingEntry = options.store
        .getBranch()
        .some((entry) => entry.type === "thinking_level_change");
      if (!hasThinkingEntry) {
        options.store.appendThinkingLevelChange(thinkingLevel);
      }
    } else {
      options.store.appendModelChange(options.model.provider, options.model.id);
      options.store.appendThinkingLevelChange(thinkingLevel);
    }

    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
  }

  // ── state ────────────────────────────────────────────────────────────────

  get model(): Model<Api> {
    return this.agent.state.model;
  }
  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }
  get systemPrompt(): string {
    return this.agent.state.systemPrompt;
  }
  set systemPrompt(prompt: string) {
    this.agent.state.systemPrompt = prompt;
  }
  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }
  get isCompacting(): boolean {
    return this.manualCompactionAbort !== undefined || this.autoCompactionAbort !== undefined;
  }
  get isRetrying(): boolean {
    return this.retryPromise !== undefined;
  }
  /** The live message array of the agent. */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }
  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }
  getSteeringMessages(): readonly string[] {
    return this.steeringMessages;
  }
  getFollowUpMessages(): readonly string[] {
    return this.followUpMessages;
  }
  /** Replace the tool set (order is the order sent to the model). */
  setTools(tools: AnyAgentTool[]): void {
    this.agent.state.tools = dedupeToolsByName(tools);
  }

  // ── events ───────────────────────────────────────────────────────────────

  subscribe(listener: AgentSessionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private emit(event: AgentSessionEvent): void {
    // A copy: a listener may unsubscribe while the event is delivered.
    for (const listener of this.listeners.slice()) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error, event);
      }
    }
  }

  private emitQueueUpdate(): void {
    this.emit({
      type: "queue_update",
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    });
  }

  private handleAgentEvent = (event: AgentEvent): void => {
    // Created synchronously: `prompt()` looks at the retry promise as soon as
    // the run resolves, possibly before this event is processed.
    this.createRetryPromiseForAgentEnd(event);
    const run = () => this.processAgentEvent(event);
    this.eventQueue = this.eventQueue.then(run, run);
    this.eventQueue.catch(() => {});
  };

  private createRetryPromiseForAgentEnd(event: AgentEvent): void {
    if (event.type !== "agent_end" || this.retryPromise || !this.settings.retry.enabled) {
      return;
    }
    let lastAssistant: AssistantMessage | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message = event.messages[i];
      if (isAssistant(message)) {
        lastAssistant = message;
        break;
      }
    }
    if (!lastAssistant || !this.isRetryableError(lastAssistant)) {
      return;
    }
    this.retryPromise = new Promise((resolve) => {
      this.retryResolve = resolve;
    });
  }

  private resolveRetry(): void {
    const resolve = this.retryResolve;
    this.retryResolve = undefined;
    this.retryPromise = undefined;
    resolve?.();
  }

  private userMessageText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter((block): block is TextContent => (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("");
  }

  private async processAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === "message_start" && event.message.role === "user") {
      this.overflowRecoveryAttempted = false;
      const text = this.userMessageText(event.message);
      if (text) {
        const steeringIndex = this.steeringMessages.indexOf(text);
        if (steeringIndex !== -1) {
          this.steeringMessages.splice(steeringIndex, 1);
          this.emitQueueUpdate();
        } else {
          const followUpIndex = this.followUpMessages.indexOf(text);
          if (followUpIndex !== -1) {
            this.followUpMessages.splice(followUpIndex, 1);
            this.emitQueueUpdate();
          }
        }
      }
    }

    this.emit(event);

    if (event.type === "message_end") {
      const message = event.message as unknown as TranscriptMessage;
      try {
        if (message.role === "custom") {
          this.sessionManager.appendCustomMessageEntry(
            message.customType as string,
            message.content,
            message.display as boolean,
            message.details,
          );
        } else if (
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult"
        ) {
          this.sessionManager.appendMessage(message);
        }
      } catch (error) {
        // The message is in memory but not on disk. Keep processing (retry
        // and compaction bookkeeping must not stall) and make the prompt fail.
        this.persistenceError ??= error;
        this.onPersistenceError?.(error);
      }
      if (isAssistant(event.message)) {
        this.lastAssistantMessage = event.message;
        if (event.message.stopReason !== "error") {
          this.overflowRecoveryAttempted = false;
          if (this.retryAttempt > 0) {
            this.emit({ type: "auto_retry_end", success: true, attempt: this.retryAttempt });
            this.retryAttempt = 0;
          }
        }
      }
    }

    if (event.type === "agent_end") {
      // A run that failed before any assistant message ended (the stream
      // function threw) reports its failure only in agent_end. pi ignores it
      // there and leaves a pending retry wait unresolved, which blocks
      // prompt(); here it is retried or checked like any other failure.
      // The failure of this run wins over an assistant message from an
      // earlier turn of the same run.
      const message = this.failureFromAgentEnd(event.messages) ?? this.lastAssistantMessage;
      this.lastAssistantMessage = undefined;
      if (!message) {
        this.resolveRetry();
        return;
      }
      if (this.isRetryableError(message)) {
        const outcome = await this.handleRetryableError(message);
        if (outcome === "retrying") {
          return;
        }
        if (outcome === "cancelled") {
          // The caller stopped the session during the backoff: no compaction
          // (a model call and a transcript write) may follow.
          this.resolveRetry();
          return;
        }
      }
      this.resolveRetry();
      if (this.disposed) {
        return;
      }
      await this.checkCompaction(message);
    }
  }

  private failureFromAgentEnd(messages: AgentMessage[]): AssistantMessage | undefined {
    const last = messages[messages.length - 1];
    return isAssistant(last) && last.stopReason === "error" ? last : undefined;
  }

  // ── prompting ────────────────────────────────────────────────────────────

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.isStreaming) {
      throw new Error(BUSY_MESSAGE);
    }
    // A stop that arrives before the run exists must still prevent it: the
    // run would start with a fresh abort controller nobody holds.
    if (this.disposed || this.abortsInFlight > 0) {
      throw abortedBeforeStart();
    }
    const epoch = this.stopEpoch;
    const stopped = () => this.disposed || this.stopEpoch !== epoch;
    this.persistenceError = undefined;
    if (this.resolveRequestAuth) {
      const auth = await this.resolveRequestAuth(this.model);
      if (stopped()) {
        throw abortedBeforeStart();
      }
      if (!auth.ok) {
        throw new Error(auth.error);
      }
    }
    const lastAssistant = this.findLastAssistantMessage();
    if (lastAssistant) {
      await this.checkCompaction(lastAssistant, false);
      if (stopped()) {
        throw abortedBeforeStart();
      }
    }
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (options?.images) {
      content.push(...options.images);
    }
    await this.agent.prompt([{ role: "user", content, timestamp: Date.now() }]);
    await this.waitForSettled();
    if (this.persistenceError !== undefined) {
      const error = this.persistenceError;
      this.persistenceError = undefined;
      const detail =
        error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
      throw new Error(`Transcript write failed: ${detail}`, { cause: error });
    }
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    this.steeringMessages.push(text);
    this.emitQueueUpdate();
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.steer({ role: "user", content, timestamp: Date.now() });
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    this.followUpMessages.push(text);
    this.emitQueueUpdate();
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.followUp({ role: "user", content, timestamp: Date.now() });
  }

  /** Abort the run in flight, a pending retry, and any scheduled run; resolves when idle. */
  async abort(): Promise<void> {
    this.stopEpoch += 1;
    this.abortsInFlight += 1;
    try {
      this.abortRetry();
      this.cancelScheduled();
      // An auto-compaction in flight would otherwise schedule its retry run
      // after this call has returned.
      this.autoCompactionAbort?.abort();
      this.agent.abort();
      await this.agent.waitForIdle();
    } finally {
      this.abortsInFlight -= 1;
    }
  }

  abortRetry(): void {
    this.retryAbort?.abort();
    this.resolveRetry();
  }

  /**
   * Resolves when nothing is running or about to run: the agent is idle,
   * every event has been processed (and persisted), and no retry or
   * post-compaction run is pending.
   */
  async waitForSettled(): Promise<void> {
    for (;;) {
      await this.agent.waitForIdle();
      const queue = this.eventQueue;
      await queue.catch(() => {});
      if (queue !== this.eventQueue) {
        continue;
      }
      if (this.retryPromise) {
        await this.retryPromise;
        continue;
      }
      if (this.scheduled.size > 0) {
        await Promise.all([...this.scheduled].map((entry) => entry.promise));
        continue;
      }
      if (this.agent.state.isStreaming) {
        continue;
      }
      return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopEpoch += 1;
    // Nothing may run or be written after teardown: resolve a retry wait,
    // cancel scheduled runs, stop compaction summaries.
    this.abortRetry();
    this.cancelScheduled();
    this.abortCompaction();
    this.disconnectFromAgent();
    this.listeners = [];
    // pi-ai keeps per-session provider resources (the Codex websocket cache).
    cleanupSessionResources(this.sessionId);
  }

  private disconnectFromAgent(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
  }

  private reconnectToAgent(): void {
    if (!this.unsubscribeAgent && !this.disposed) {
      this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
    }
  }

  private findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (isAssistant(message)) {
        return message;
      }
    }
    return undefined;
  }

  /** Run `agent.continue()` after `delayMs`, tracked so `prompt()` waits for it. */
  private scheduleContinue(delayMs: number): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = {
      promise,
      cancel: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          this.scheduled.delete(entry);
          finish();
        }
      },
    };
    this.scheduled.add(entry);
    timer = setTimeout(() => {
      timer = undefined;
      const done = () => {
        this.scheduled.delete(entry);
        finish();
      };
      if (this.disposed) {
        done();
        return;
      }
      this.agent.continue().then(done, () => {
        // The run could not start, so no agent_end will follow. Resolve the
        // retry wait and tell listeners the announced retry is over: the
        // runner's subscriber counts an agent_end against every
        // compaction_end with willRetry.
        this.resolveRetry();
        this.emit({ type: "agent_end", messages: this.agent.state.messages });
        done();
      });
    }, delayMs);
  }

  private cancelScheduled(): void {
    // A copy: cancel() removes the entry from the set.
    for (const entry of Array.from(this.scheduled)) {
      entry.cancel();
    }
  }

  private convertToLlm(messages: AgentMessage[]): ReturnType<typeof convertToLlm> {
    const converted = convertToLlm(messages as SessionMessage[]);
    if (!this.settings.blockImages) {
      return converted;
    }
    return converted.map((message) => {
      if (message.role !== "user" && message.role !== "toolResult") {
        return message;
      }
      const content = message.content;
      if (!Array.isArray(content) || !content.some((block) => block.type === "image")) {
        return message;
      }
      const filtered = content
        .map((block): TextContent | ImageContent =>
          block.type === "image" ? { type: "text", text: IMAGES_DISABLED } : block,
        )
        .filter((block, index, all) => {
          const previous = all[index - 1];
          return !(
            block.type === "text" &&
            block.text === IMAGES_DISABLED &&
            previous?.type === "text" &&
            previous.text === IMAGES_DISABLED
          );
        });
      return { ...message, content: filtered } as typeof message;
    });
  }

  // ── retry ────────────────────────────────────────────────────────────────

  private isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) {
      return false;
    }
    if (isContextOverflow(message, this.model.contextWindow ?? 0)) {
      return false;
    }
    return RETRYABLE_ERROR.test(message.errorMessage);
  }

  /** "retrying": a retry run was scheduled. "cancelled": the backoff was aborted. */
  private async handleRetryableError(
    message: AssistantMessage,
  ): Promise<"retrying" | "cancelled" | "exhausted"> {
    const retry = this.settings.retry;
    if (!retry.enabled) {
      this.resolveRetry();
      return "exhausted";
    }
    if (!this.retryPromise) {
      this.retryPromise = new Promise((resolve) => {
        this.retryResolve = resolve;
      });
    }
    this.retryAttempt += 1;
    if (this.retryAttempt > retry.maxRetries) {
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryAttempt - 1,
        finalError: message.errorMessage,
      });
      this.retryAttempt = 0;
      this.resolveRetry();
      return "exhausted";
    }
    const delayMs = retry.baseDelayMs * 2 ** (this.retryAttempt - 1);
    this.emit({
      type: "auto_retry_start",
      attempt: this.retryAttempt,
      maxAttempts: retry.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
    });
    // The errored message stays in the transcript; the next run must not see it.
    const messages = this.agent.state.messages;
    if (isAssistant(messages[messages.length - 1])) {
      this.agent.state.messages = messages.slice(0, -1);
    }
    this.retryAbort = new AbortController();
    try {
      await abortableSleep(delayMs, this.retryAbort.signal);
    } catch {
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      this.retryAbort = undefined;
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      this.resolveRetry();
      return "cancelled";
    }
    this.retryAbort = undefined;
    // The retry promise is resolved by the retried run's agent_end.
    this.scheduleContinue(0);
    return "retrying";
  }

  // ── compaction ───────────────────────────────────────────────────────────

  abortCompaction(): void {
    this.manualCompactionAbort?.abort();
    this.autoCompactionAbort?.abort();
  }

  private async requestAuth(): Promise<RequestAuthResult> {
    if (!this.resolveRequestAuth) {
      return { ok: true };
    }
    return this.resolveRequestAuth(this.model);
  }

  /** Manual compaction. Throws when there is nothing to compact or the summary fails. */
  async compact(customInstructions?: string): Promise<CompactionOutcome> {
    this.disconnectFromAgent();
    await this.abort();
    const controller = new AbortController();
    this.manualCompactionAbort = controller;
    this.emit({ type: "compaction_start", reason: "manual" });
    try {
      const auth = await this.requestAuth();
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const pathEntries = this.sessionManager.getBranch();
      const result = await this.policy.compact({
        reason: "manual",
        pathEntries,
        settings: this.settings.compaction,
        model: this.model,
        streamFn: this.agent.streamFn,
        apiKey: auth.apiKey,
        headers: auth.headers,
        customInstructions,
        signal: controller.signal,
        thinkingLevel: this.thinkingLevel,
      });
      if (!result) {
        const last = pathEntries[pathEntries.length - 1];
        if (last?.type === "compaction") {
          throw new Error("Already compacted");
        }
        throw new Error("Nothing to compact (session too small)");
      }
      if (controller.signal.aborted) {
        throw new Error("Compaction cancelled");
      }
      if (isStubsOnly(result)) {
        this.recordStubs(result.stubs, "manual");
        throw new Error("Nothing to compact (no turn boundary to cut at)");
      }
      this.applyCompaction(result, "manual");
      this.emit({
        type: "compaction_end",
        reason: "manual",
        result,
        aborted: false,
        willRetry: false,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        message === "Compaction cancelled" ||
        (error instanceof Error && error.name === "AbortError");
      this.emit({
        type: "compaction_end",
        reason: "manual",
        result: undefined,
        aborted,
        willRetry: false,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
      });
      throw error;
    } finally {
      this.manualCompactionAbort = undefined;
      this.reconnectToAgent();
    }
  }

  private applyCompaction(result: CompactionOutcome, trigger: string): void {
    if (this.disposed) {
      // The caller tore the session down (and released its lock) while the
      // summary was being produced.
      throw new Error("Compaction cancelled");
    }
    const stubs = result.stubs ?? [];
    if (stubs.length > 0) {
      this.sessionManager.appendCustomEntry(
        PRUNE_RECORD_CUSTOM_TYPE,
        buildPruneRecordData(stubs, trigger),
      );
    }
    this.sessionManager.appendCompaction(
      result.summary,
      result.firstKeptEntryId,
      result.tokensBefore,
      result.details,
      false,
    );
    this.agent.state.messages = this.sessionManager.buildSessionContext()
      .messages as unknown as AgentMessage[];
    // The context was rebuilt from the transcript, which holds every tool
    // output in full: re-apply all stubs recorded on the branch, not only
    // the ones this compaction added.
    this.applyStubsToState([...collectStubRecords(this.sessionManager.getBranch()).values()]);
  }

  /** Record tool-output stubs in the transcript and apply them to the live context. */
  private recordStubs(stubs: ToolOutputStub[], trigger: string): void {
    if (stubs.length === 0 || this.disposed) {
      return;
    }
    this.sessionManager.appendCustomEntry(
      PRUNE_RECORD_CUSTOM_TYPE,
      buildPruneRecordData(stubs, trigger),
    );
    this.applyStubsToState(stubs);
  }

  private applyStubsToState(stubs: ToolOutputStub[]): void {
    if (stubs.length === 0) {
      return;
    }
    const byCall = new Map(stubs.map((stub) => [stub.toolCallId, stub]));
    const applied = applyStubsToMessages(
      this.agent.state.messages as unknown as Parameters<typeof applyStubsToMessages>[0],
      byCall,
    );
    if (applied.applied > 0) {
      this.agent.state.messages = applied.messages as unknown as AgentMessage[];
    }
  }

  private async checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
  ): Promise<void> {
    const settings = this.settings.compaction;
    if (!settings.enabled) {
      return;
    }
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") {
      return;
    }
    const contextWindow = this.model.contextWindow ?? 0;
    const sameModel =
      assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
    const compactionEntry = latestCompactionEntry(this.sessionManager.getBranch());
    const compactedAt = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : null;
    if (compactedAt !== null && assistantMessage.timestamp <= compactedAt) {
      return;
    }

    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this.overflowRecoveryAttempted) {
        this.emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: OVERFLOW_RETRY_FAILED,
        });
        return;
      }
      this.overflowRecoveryAttempted = true;
      const messages = this.agent.state.messages;
      if (isAssistant(messages[messages.length - 1])) {
        this.agent.state.messages = messages.slice(0, -1);
      }
      await this.runAutoCompaction("overflow", true);
      return;
    }

    let contextTokens: number;
    if (assistantMessage.stopReason === "error") {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages as SessionMessage[]);
      if (estimate.lastUsageIndex === null) {
        return;
      }
      const usageMessage = messages[estimate.lastUsageIndex];
      if (
        compactedAt !== null &&
        isAssistant(usageMessage) &&
        usageMessage.timestamp <= compactedAt
      ) {
        return;
      }
      contextTokens = estimate.tokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    const phase = skipAbortedCheck ? "turn-end" : "turn-start";
    if (this.policy.shouldCompact({ contextTokens, contextWindow, settings, phase })) {
      await this.runAutoCompaction("threshold", false);
    }
  }

  private async runAutoCompaction(
    reason: "threshold" | "overflow",
    willRetry: boolean,
  ): Promise<void> {
    this.emit({ type: "compaction_start", reason });
    const controller = new AbortController();
    this.autoCompactionAbort = controller;
    const skipped = (aborted: boolean) =>
      this.emit({ type: "compaction_end", reason, result: undefined, aborted, willRetry: false });
    try {
      const auth = await this.requestAuth();
      if (!auth.ok) {
        skipped(false);
        return;
      }
      const result = await this.policy.compact({
        reason,
        pathEntries: this.sessionManager.getBranch(),
        settings: this.settings.compaction,
        model: this.model,
        streamFn: this.agent.streamFn,
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: controller.signal,
        thinkingLevel: this.thinkingLevel,
      });
      if (!result) {
        skipped(false);
        return;
      }
      if (controller.signal.aborted || this.disposed) {
        skipped(true);
        return;
      }
      if (isStubsOnly(result)) {
        this.recordStubs(result.stubs, reason);
        this.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: false,
          willRetry,
        });
      } else {
        this.applyCompaction(result, reason);
        this.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
      }
      if (controller.signal.aborted || this.disposed) {
        // Stopped while the result was being applied: no run may follow.
        return;
      }
      if (willRetry) {
        // The transcript keeps every errored attempt (a retried 429, then the
        // overflow). None of them may be the last message of the retry.
        let messages = this.agent.state.messages;
        let end = messages.length;
        while (end > 0) {
          const candidate = messages[end - 1];
          if (!isAssistant(candidate) || candidate.stopReason !== "error") {
            break;
          }
          end -= 1;
        }
        if (end !== messages.length) {
          messages = messages.slice(0, end);
          this.agent.state.messages = messages;
        }
        this.scheduleContinue(100);
      } else if (this.agent.hasQueuedMessages()) {
        this.scheduleContinue(100);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "compaction failed";
      this.emit({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage:
          reason === "overflow"
            ? `Context overflow recovery failed: ${message}`
            : `Auto-compaction failed: ${message}`,
      });
    } finally {
      this.autoCompactionAbort = undefined;
    }
  }
}
