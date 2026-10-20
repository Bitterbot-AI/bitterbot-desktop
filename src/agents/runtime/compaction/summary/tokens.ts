/**
 * PLAN-52 Phase 3: token accounting for summary compaction.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/compaction/compaction.js`: `DEFAULT_COMPACTION_SETTINGS`,
 * `calculateContextTokens`, `getLastAssistantUsage`, `estimateContextTokens`,
 * `shouldCompact`, `estimateTokens`.
 *
 * Differences from the original: typing only (entries are our
 * `TranscriptEntry`, messages our `SessionMessage`).
 *
 * Kept as in pi, on purpose:
 * - The estimate is chars / 4, rounded up per message.
 * - Images in user content count as 0; images in tool results and custom
 *   messages count as 4800 chars (1200 tokens) each.
 * - An assistant message that was aborted or errored has no usable usage.
 * - A message with an unknown role counts as 0.
 */
import type { Usage } from "@mariozechner/pi-ai";
import type { TranscriptEntry } from "../../transcript/types.js";
import { type SessionMessage, toSessionMessage } from "./messages.js";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/**
 * Total context tokens of a usage record: the provider's `totalTokens` when it
 * is set (non-zero), otherwise the sum of the components.
 */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Usage of an assistant message, unless it was aborted or errored. */
function getAssistantUsage(msg: SessionMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    if (msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage) {
      return msg.usage;
    }
  }
  return undefined;
}

/** Usage of the last assistant message entry that was not aborted or errored. */
export function getLastAssistantUsage(entries: readonly TranscriptEntry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(toSessionMessage(entry.message));
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

function getLastAssistantUsageInfo(
  messages: readonly SessionMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      return { usage, index: i };
    }
  }
  return undefined;
}

export interface ContextUsageEstimate {
  /** `usageTokens + trailingTokens`. */
  tokens: number;
  /** Context tokens reported by the last usable assistant usage, or 0. */
  usageTokens: number;
  /** Estimate for the messages after that assistant message (all, if none). */
  trailingTokens: number;
  /** Index of that assistant message, or null. */
  lastUsageIndex: number | null;
}

/**
 * Context size of a message list: the last usable assistant usage plus an
 * estimate for the messages after it. Without any usage, everything is
 * estimated.
 */
export function estimateContextTokens(messages: readonly SessionMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** True when the context no longer leaves `reserveTokens` free in the window. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** Estimate the tokens of one message with the chars / 4 heuristic. */
export function estimateTokens(message: SessionMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user": {
      const content = message.content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      for (const block of message.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
          if (block.type === "image") {
            // An image counts as 4800 chars, which is 1200 tokens.
            chars += 4800;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = message.command.length + message.output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = message.summary.length;
      return Math.ceil(chars / 4);
    }
    default:
      // A role this port does not know (possible in a stored transcript).
      return 0;
  }
}
