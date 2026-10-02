/**
 * Mid-turn context budget guard.
 *
 * pi-coding-agent's auto-compaction fires reactively (after the model
 * returns a context-overflow error) and only between top-level run()
 * iterations. During a long single-turn tool loop (50 tool calls each
 * adding 100KB+ of output), context can grow unbounded between LLM
 * calls and we don't get the chance to compact until the next run.
 *
 * This module fires inside our subscription handler after each tool
 * result is committed: cheap char check, then a token estimate, and
 * only if we cross the trigger threshold do we run progressive
 * compression and assign session.agent.state.messages. Progressive
 * compression is deterministic (no LLM calls), so calling it from
 * inside an active run is safe.
 *
 * Heavy LLM-based summary compaction is intentionally NOT invoked from
 * here. That requires a separate run() and goes through the existing
 * compactEmbeddedPiSession flow with its lane queueing. Mid-turn we
 * just want to keep the message volume bounded so the next LLM call
 * doesn't overflow.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  compressOldMessages,
  type ProgressiveCompressionConfig,
} from "../progressive-compression.js";
import {
  applyStubsToMessages,
  planMessageStubs,
  type ToolOutputStub,
} from "../runtime/context-pruning/offload-stubs.js";
import { estimateTokens } from "../runtime/tokens.js";

const DEFAULT_TRIGGER_FRACTION = 0.8;
const DEFAULT_MIN_CHARS = 80_000;
const DEFAULT_TARGET_FRACTION = 0.65;
/** PLAN-52A T3: tool-output stubs aim lower than compression, so they act less often. */
const DEFAULT_STUB_TARGET_FRACTION = 0.5;

/**
 * PLAN-52A tool-output stubs (T3). When enabled, the guard first replaces the
 * oldest tool outputs with a stub naming the tool call id (the full text stays
 * in the transcript, `recall_range` returns it). Progressive compression only
 * runs if stubs alone do not reach its target. The caller persists the
 * returned stubs as a `bitterbot.offload-prune` entry.
 */
export type MidTurnStubConfig = {
  enabled: boolean;
  /** Target as a fraction of the context window. Default 0.50. */
  targetFraction?: number;
  /** Tool outputs below this estimate are never stubbed. Default 1000. */
  minTokens?: number;
  /** Most recent tool outputs never stubbed. Default 2. */
  spareRecent?: number;
};

export type MidTurnBudgetConfig = {
  /** Fraction of context window above which the guard fires. Default 0.80. */
  triggerThresholdFraction?: number;
  /** Target compression budget as a fraction of context window. Default 0.65. */
  targetFraction?: number;
  /** Don't bother running estimateTokens below this char count. Default 80000. */
  minChars?: number;
};

export type MidTurnBudgetSessionLike = {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
};

export type MidTurnBudgetResult =
  | {
      applied: false;
      reason: string;
      messages: number;
      chars: number;
      tokensBefore?: number;
    }
  | {
      applied: true;
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      passes: number;
      /** Tool outputs stubbed by this call (persist them as a prune record). */
      stubs?: ToolOutputStub[];
      method: "stubs" | "compression" | "stubs+compression";
    };

function getMessageChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") total += text.length;
  }
  return total;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  let estimationFailed = false;
  for (const m of messages) {
    if (estimationFailed) {
      total += Math.ceil(getMessageChars(m) / 4);
      continue;
    }
    try {
      total += estimateTokens(m);
    } catch {
      estimationFailed = true;
      total += Math.ceil(getMessageChars(m) / 4);
    }
  }
  return total;
}

/**
 * Inspect the session's current message volume and, if it exceeds the
 * trigger threshold, replace its messages with a progressively-compressed
 * variant. The session is mutated in place via session.agent.state.messages.
 *
 * Safe to call concurrently with an in-flight run because progressive
 * compression doesn't make any LLM calls and the state.messages assignment is the same
 * mechanism pi-coding-agent uses for its own auto-compaction.
 */
export function applyMidTurnBudget(params: {
  session: MidTurnBudgetSessionLike;
  contextWindowTokens: number;
  compressionConfig?: ProgressiveCompressionConfig;
  budgetConfig?: MidTurnBudgetConfig;
  stubConfig?: MidTurnStubConfig;
}): MidTurnBudgetResult {
  const messages = params.session.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { applied: false, reason: "no messages", messages: 0, chars: 0 };
  }

  const triggerFraction = params.budgetConfig?.triggerThresholdFraction ?? DEFAULT_TRIGGER_FRACTION;
  const targetFraction = params.budgetConfig?.targetFraction ?? DEFAULT_TARGET_FRACTION;
  const minChars = params.budgetConfig?.minChars ?? DEFAULT_MIN_CHARS;

  // Cheap pre-check on raw chars to avoid running estimateTokens on every
  // tool-call exit when the session is small.
  let chars = 0;
  for (const m of messages) chars += getMessageChars(m);
  if (chars < minChars) {
    return { applied: false, reason: "below char floor", messages: messages.length, chars };
  }

  const tokensBefore = estimateMessagesTokens(messages);
  const triggerTokens = Math.floor(params.contextWindowTokens * triggerFraction);
  if (tokensBefore < triggerTokens) {
    return {
      applied: false,
      reason: "below trigger threshold",
      messages: messages.length,
      chars,
      tokensBefore,
    };
  }

  const targetBudget = Math.floor(params.contextWindowTokens * targetFraction);

  // Step 1 (PLAN-52A T3): stub the oldest tool outputs. Lossless (the
  // transcript keeps the text) and persistent (the caller records the stubs).
  let working: AgentMessage[] = messages;
  let stubs: ToolOutputStub[] = [];
  let tokensAfterStubs = tokensBefore;
  if (params.stubConfig?.enabled) {
    const stubTarget = Math.floor(
      params.contextWindowTokens *
        (params.stubConfig.targetFraction ?? DEFAULT_STUB_TARGET_FRACTION),
    );
    stubs = planMessageStubs({
      messages,
      estimate: (m) => estimateMessagesTokens([m]),
      totalTokens: tokensBefore,
      targetTokens: stubTarget,
      settings: {
        ...(typeof params.stubConfig.minTokens === "number"
          ? { minTokens: params.stubConfig.minTokens }
          : {}),
        ...(typeof params.stubConfig.spareRecent === "number"
          ? { spareRecent: params.stubConfig.spareRecent }
          : {}),
      },
    });
    if (stubs.length > 0) {
      working = applyStubsToMessages(
        messages,
        new Map(stubs.map((s) => [s.toolCallId, s])),
      ).messages;
      tokensAfterStubs = estimateMessagesTokens(working);
      if (tokensAfterStubs <= targetBudget) {
        params.session.agent.state.messages = working;
        return {
          applied: true,
          tokensBefore,
          tokensAfter: tokensAfterStubs,
          messagesBefore: messages.length,
          messagesAfter: working.length,
          passes: 0,
          stubs,
          method: "stubs",
        };
      }
    }
  }

  // Step 2: progressive compression (deterministic truncation), on top of
  // whatever the stubs already freed.
  const result = compressOldMessages([...working], targetBudget, {
    enabled: true,
    ...params.compressionConfig,
  });

  if (result.totalCompressed === 0 || result.tokensAfter >= result.tokensBefore) {
    if (stubs.length > 0) {
      // Stubs made progress even though compression could not add to it.
      params.session.agent.state.messages = working;
      return {
        applied: true,
        tokensBefore,
        tokensAfter: tokensAfterStubs,
        messagesBefore: messages.length,
        messagesAfter: working.length,
        passes: 0,
        stubs,
        method: "stubs",
      };
    }
    return {
      applied: false,
      reason: "compression made no progress",
      messages: messages.length,
      chars,
      tokensBefore,
    };
  }

  params.session.agent.state.messages = result.messages;

  return {
    applied: true,
    tokensBefore,
    tokensAfter: result.tokensAfter,
    messagesBefore: messages.length,
    messagesAfter: result.messages.length,
    passes: result.passesRun,
    ...(stubs.length > 0 ? { stubs } : {}),
    method: stubs.length > 0 ? "stubs+compression" : "compression",
  };
}

/** @internal */
export const __midTurnBudgetConsts = Object.freeze({
  DEFAULT_TRIGGER_FRACTION,
  DEFAULT_MIN_CHARS,
  DEFAULT_TARGET_FRACTION,
  DEFAULT_STUB_TARGET_FRACTION,
});
