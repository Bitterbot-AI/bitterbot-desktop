/**
 * Heartbeat classification for the offload policy.
 *
 * Same rules as `src/infra/usage-transcript-classify.ts` (the PLAN-50 relabel
 * classifier), kept local so the pure planning layer does not pull provider
 * code through that module's import of `extra-params.ts`.
 */

import { HEARTBEAT_PROMPT_PREFIX } from "../../../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../../../auto-reply/tokens.js";
import type { BitterbotConfig } from "../../../config/config.js";

/** Default heartbeat prompt plus every configured override (global and per agent). */
export function resolveHeartbeatPromptSet(cfg: BitterbotConfig | undefined): string[] {
  const out = new Set<string>([HEARTBEAT_PROMPT_PREFIX.trim()]);
  const push = (raw: unknown) => {
    if (typeof raw === "string" && raw.trim()) {
      out.add(raw.trim());
    }
  };
  push(cfg?.agents?.defaults?.heartbeat?.prompt);
  const list = (cfg?.agents as { list?: Array<Record<string, unknown>> } | undefined)?.list;
  for (const agent of Array.isArray(list) ? list : []) {
    push((agent?.heartbeat as { prompt?: unknown } | undefined)?.prompt);
  }
  return Array.from(out);
}

/** First words of the block the runner puts in front of a user message (transcript-recall.ts). */
export const INJECTED_RECALL_HEADER_PREFIX =
  "Recalled from earlier in this conversation (automatic";

/**
 * A persisted user message without what the runner put in front of it: the
 * proactive recall block and queued `System:` event lines. What is left is
 * what the user (or the heartbeat) said. Used wherever the text is classified
 * or quoted (heartbeat detection, ledger threads, the recall index), so that
 * injected text is never mistaken for, or re-injected as, user text.
 */
export function userAuthoredText(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  for (;;) {
    while (i < lines.length && lines[i]!.trim() === "") {
      i++;
    }
    if (i >= lines.length) {
      break;
    }
    const line = lines[i]!;
    if (line.startsWith(INJECTED_RECALL_HEADER_PREFIX)) {
      // The block runs to the first blank line.
      i++;
      while (i < lines.length && lines[i]!.trim() !== "") {
        i++;
      }
      continue;
    }
    if (line.startsWith("System: ")) {
      i++;
      continue;
    }
    break;
  }
  return i === 0 ? text : lines.slice(i).join("\n");
}

/** The user turn is a heartbeat prompt (the runner appends a "Current time" line after it). */
export function isHeartbeatPromptText(text: string, prompts: readonly string[]): boolean {
  const trimmed = userAuthoredText(text).trim();
  if (!trimmed) {
    return false;
  }
  return prompts.some((p) => p && trimmed.startsWith(p));
}

/** The assistant reply is only the ack token (allowing markup such as **HEARTBEAT_OK**). */
export function isHeartbeatAckText(text: string): boolean {
  const normalized = text
    .replace(/<[^>]+>/g, "")
    .replace(/[*`~]/g, "")
    .trim()
    .replace(/^_+|_+$/g, "")
    .trim();
  return normalized === HEARTBEAT_TOKEN;
}

/** Plain text of a transcript message (string content or text blocks). */
export function transcriptMessageText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}
