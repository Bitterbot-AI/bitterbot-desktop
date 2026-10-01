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

/** The user turn is a heartbeat prompt (the runner appends a "Current time" line after it). */
export function isHeartbeatPromptText(text: string, prompts: readonly string[]): boolean {
  const trimmed = text.trim();
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
