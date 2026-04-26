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
 * compression and call session.agent.replaceMessages. Progressive
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
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import {
  compressOldMessages,
  type ProgressiveCompressionConfig,
} from "../progressive-compression.js";

const DEFAULT_TRIGGER_FRACTION = 0.8;
const DEFAULT_MIN_CHARS = 80_000;
const DEFAULT_TARGET_FRACTION = 0.65;

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
  agent: { replaceMessages: (messages: AgentMessage[]) => void };
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
 * variant. The session is mutated in place via session.agent.replaceMessages.
 *
 * Safe to call concurrently with an in-flight run because progressive
 * compression doesn't make any LLM calls and replaceMessages is the same
 * mechanism pi-coding-agent uses for its own auto-compaction.
 */
export function applyMidTurnBudget(params: {
  session: MidTurnBudgetSessionLike;
  contextWindowTokens: number;
  compressionConfig?: ProgressiveCompressionConfig;
  budgetConfig?: MidTurnBudgetConfig;
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
  const result = compressOldMessages([...messages], targetBudget, {
    enabled: true,
    ...params.compressionConfig,
  });

  if (result.totalCompressed === 0 || result.tokensAfter >= result.tokensBefore) {
    return {
      applied: false,
      reason: "compression made no progress",
      messages: messages.length,
      chars,
      tokensBefore,
    };
  }

  params.session.agent.replaceMessages(result.messages);

  return {
    applied: true,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    messagesBefore: messages.length,
    messagesAfter: result.messages.length,
    passes: result.passesRun,
  };
}

/** @internal */
export const __midTurnBudgetConsts = Object.freeze({
  DEFAULT_TRIGGER_FRACTION,
  DEFAULT_MIN_CHARS,
  DEFAULT_TARGET_FRACTION,
});
