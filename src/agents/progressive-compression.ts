/**
 * Progressive Context Compression
 * Adapted from Bitterbot-Core's ThreadManager._compress_messages.
 *
 * Runs BEFORE expensive LLM-based compaction to reduce token count
 * through deterministic truncation strategies. This means:
 * - Short conversations: no compression at all
 * - Medium conversations: cheap truncation only, no LLM calls
 * - Long conversations: cheap truncation first, then LLM summarization on the reduced set
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";

export interface ProgressiveCompressionConfig {
  /** Enable progressive compression (default: true). */
  enabled?: boolean;
  /** Max tokens per old tool result before truncation (default: 4096). */
  toolResultThreshold?: number;
  /** Max tokens per old user/assistant message before truncation (default: 2048). */
  messageThreshold?: number;
  /** Max halving iterations (default: 3). */
  maxIterations?: number;
  /** Hard cap on total message count before middle-out removal (default: 320). */
  middleOutMaxMessages?: number;
  /** How many recent tool results to never compress (default: 2). */
  spareRecentToolResults?: number;
  /** How many recent messages per role to never compress (default: 4). */
  spareRecentMessages?: number;
}

const DEFAULTS: Required<ProgressiveCompressionConfig> = {
  enabled: true,
  toolResultThreshold: 4096,
  messageThreshold: 2048,
  maxIterations: 3,
  middleOutMaxMessages: 320,
  spareRecentToolResults: 2,
  spareRecentMessages: 4,
};

// ---------------------------------------------------------------------------
// Truncated-original storage for expand_message tool
// ---------------------------------------------------------------------------

const MAX_STORED_ORIGINALS = 100;

/** In-memory map: fingerprint → original content. Session-scoped. */
const truncatedOriginals = new Map<string, string>();

export function getOriginalContent(fingerprint: string): string | undefined {
  return truncatedOriginals.get(fingerprint);
}

export function getTruncatedOriginalsSize(): number {
  return truncatedOriginals.size;
}

function storeOriginal(content: string): string {
  const fingerprint = createHash("sha256").update(content).digest("hex").slice(0, 12);
  // Evict oldest if at capacity
  if (truncatedOriginals.size >= MAX_STORED_ORIGINALS && !truncatedOriginals.has(fingerprint)) {
    const oldest = truncatedOriginals.keys().next().value;
    if (oldest) {
      truncatedOriginals.delete(oldest);
    }
  }
  truncatedOriginals.set(fingerprint, content);
  return fingerprint;
}

/** Clear the truncated originals store (e.g. on session end). */
export function clearTruncatedOriginals(): void {
  truncatedOriginals.clear();
}

// ---------------------------------------------------------------------------
// Core compression utilities
// ---------------------------------------------------------------------------

/**
 * Middle-out truncation: keep first half + last half of a text,
 * with a marker in between.
 */
export function middleOutTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n\n... [middle truncated] ...\n\n${tail}`;
}

/**
 * Truncate content and store a reference to the original so the
 * expand_message tool can retrieve it later.
 */
export function truncateWithReference(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const fingerprint = storeOriginal(content);
  const truncated = middleOutTruncate(content, maxChars);
  return `${truncated}\n\n[Content truncated. Reference: ${fingerprint} — use expand_message tool to retrieve full content]`;
}

// ---------------------------------------------------------------------------
// Message text extraction helpers
// ---------------------------------------------------------------------------

function getMessageText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

function setMessageText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { ...msg, content: text } as unknown as AgentMessage;
  }
  if (Array.isArray(content)) {
    let replaced = false;
    const newContent = content.map((block) => {
      if (!replaced && block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        replaced = true;
        return { ...block, text };
      }
      return block;
    });
    return { ...msg, content: newContent } as unknown as AgentMessage;
  }
  return msg;
}

function estimateMessageTokens(msg: AgentMessage): number {
  try {
    return estimateTokens(msg);
  } catch {
    // Fallback: rough char-based estimate
    return Math.ceil(getMessageText(msg).length / 4);
  }
}

function getMessageRole(msg: AgentMessage): string {
  return typeof (msg as { role?: unknown }).role === "string"
    ? (msg as { role: string }).role
    : "unknown";
}

// ---------------------------------------------------------------------------
// Compression passes
// ---------------------------------------------------------------------------

/**
 * Pass 1: Compress old tool result messages that exceed the token threshold.
 * Spares the N most recent tool results.
 */
function compressToolResults(
  messages: AgentMessage[],
  threshold: number,
  spareRecent: number,
): { messages: AgentMessage[]; compressed: number } {
  // Find indices of all tool result messages
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (getMessageRole(messages[i]) === "toolResult") {
      toolResultIndices.push(i);
    }
  }

  // Identify indices to spare (most recent N)
  const sparedIndices = new Set(toolResultIndices.slice(-spareRecent));
  let compressed = 0;
  const out = messages.map((msg, i) => {
    if (!toolResultIndices.includes(i) || sparedIndices.has(i)) return msg;
    const tokens = estimateMessageTokens(msg);
    if (tokens <= threshold) return msg;
    const text = getMessageText(msg);
    // Use ~4 chars per token as rough estimate for maxChars
    const maxChars = threshold * 4;
    const truncated = truncateWithReference(text, maxChars);
    compressed++;
    return setMessageText(msg, truncated);
  });
  return { messages: out, compressed };
}

/**
 * Pass 2/3: Compress old user or assistant messages that exceed the token threshold.
 * Spares the N most recent messages of that role.
 */
function compressMessagesByRole(
  messages: AgentMessage[],
  role: string,
  threshold: number,
  spareRecent: number,
): { messages: AgentMessage[]; compressed: number } {
  const roleIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (getMessageRole(messages[i]) === role) {
      roleIndices.push(i);
    }
  }

  const sparedIndices = new Set(roleIndices.slice(-spareRecent));
  let compressed = 0;
  const out = messages.map((msg, i) => {
    if (!roleIndices.includes(i) || sparedIndices.has(i)) return msg;
    const tokens = estimateMessageTokens(msg);
    if (tokens <= threshold) return msg;
    const text = getMessageText(msg);
    const maxChars = threshold * 4;
    const truncated = truncateWithReference(text, maxChars);
    compressed++;
    return setMessageText(msg, truncated);
  });
  return { messages: out, compressed };
}

/**
 * Pass 5 (nuclear): Middle-out message removal.
 * Keep the first N and last N messages, drop the middle.
 */
function middleOutMessages(
  messages: AgentMessage[],
  maxMessages: number,
): AgentMessage[] {
  if (messages.length <= maxMessages) return messages;
  const half = Math.floor(maxMessages / 2);
  const head = messages.slice(0, half);
  const tail = messages.slice(-half);
  return [...head, ...tail];
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

function estimateAllTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

export interface CompressResult {
  messages: AgentMessage[];
  totalCompressed: number;
  passesRun: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Progressively compress old messages through multiple passes:
 * 1. Compress tool results (threshold: toolResultThreshold)
 * 2. Compress old user messages (threshold: messageThreshold)
 * 3. Compress old assistant messages (threshold: messageThreshold)
 * 4. Halve thresholds and repeat (up to maxIterations)
 * 5. Middle-out message removal (hard cap)
 *
 * Returns the compressed messages and statistics.
 */
export function compressOldMessages(
  messages: AgentMessage[],
  contextBudget: number,
  config?: ProgressiveCompressionConfig,
): CompressResult {
  const cfg = { ...DEFAULTS, ...config };
  if (!cfg.enabled) {
    return {
      messages,
      totalCompressed: 0,
      passesRun: 0,
      tokensBefore: estimateAllTokens(messages),
      tokensAfter: estimateAllTokens(messages),
    };
  }

  const tokensBefore = estimateAllTokens(messages);
  // Don't compress if already under budget
  if (tokensBefore <= contextBudget) {
    return { messages, totalCompressed: 0, passesRun: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  let current = messages;
  let totalCompressed = 0;
  let passesRun = 0;
  let toolThreshold = cfg.toolResultThreshold;
  let msgThreshold = cfg.messageThreshold;

  for (let iter = 0; iter < cfg.maxIterations; iter++) {
    // Pass 1: Compress tool results
    const toolPass = compressToolResults(current, toolThreshold, cfg.spareRecentToolResults);
    current = toolPass.messages;
    totalCompressed += toolPass.compressed;
    passesRun++;

    if (estimateAllTokens(current) <= contextBudget) break;

    // Pass 2: Compress user messages
    const userPass = compressMessagesByRole(current, "user", msgThreshold, cfg.spareRecentMessages);
    current = userPass.messages;
    totalCompressed += userPass.compressed;
    passesRun++;

    if (estimateAllTokens(current) <= contextBudget) break;

    // Pass 3: Compress assistant messages
    const assistantPass = compressMessagesByRole(
      current,
      "assistant",
      msgThreshold,
      cfg.spareRecentMessages,
    );
    current = assistantPass.messages;
    totalCompressed += assistantPass.compressed;
    passesRun++;

    if (estimateAllTokens(current) <= contextBudget) break;

    // Halve thresholds for next iteration
    toolThreshold = Math.max(256, Math.floor(toolThreshold / 2));
    msgThreshold = Math.max(256, Math.floor(msgThreshold / 2));
  }

  // Pass 5 (nuclear): Middle-out message removal if still over budget
  if (estimateAllTokens(current) > contextBudget && current.length > cfg.middleOutMaxMessages) {
    current = middleOutMessages(current, cfg.middleOutMaxMessages);
    passesRun++;
  }

  return {
    messages: current,
    totalCompressed,
    passesRun,
    tokensBefore,
    tokensAfter: estimateAllTokens(current),
  };
}
