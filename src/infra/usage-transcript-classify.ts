/**
 * PLAN-50: classify transcript turns by content.
 *
 * Heartbeats share the agent's main session, so the session key cannot tell a heartbeat tick
 * from a user turn and `sessions.json` only knows the current transcript per key (sessions
 * rotate daily). The transcript itself is unambiguous: the user turn is the heartbeat prompt
 * (default `HEARTBEAT_PROMPT`, or the configured override) with a "Current time" line appended,
 * and the assistant reply is usually just `HEARTBEAT_OK`. Every assistant message after a
 * heartbeat prompt, up to the next user message, belongs to that heartbeat (tool loops included).
 */

import type { BitterbotConfig } from "../config/config.js";
import { resolveCacheTtlLabel } from "../agents/pi-embedded-runner/extra-params.js";
import { HEARTBEAT_PROMPT_PREFIX } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";

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

/**
 * Stateful walker over one transcript: feed every line in order and ask, for each assistant
 * message, whether it belongs to a heartbeat. Cheap: lines that cannot carry a user turn or a
 * priced assistant turn are not parsed.
 */
export class HeartbeatTurnTracker {
  private readonly prompts: readonly string[];
  private inHeartbeat = false;

  constructor(prompts: readonly string[]) {
    this.prompts = prompts;
  }

  static mayCarryUserTurn(line: string): boolean {
    return line.includes('"role":"user"') || line.includes('"role": "user"');
  }

  /** Track a parsed transcript entry's user turn; call for every entry, in file order. */
  noteEntry(entry: Record<string, unknown> | null | undefined): void {
    const message = entry?.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object" || message.role !== "user") {
      return;
    }
    this.inHeartbeat = isHeartbeatPromptText(transcriptMessageText(message), this.prompts);
  }

  /** True when this assistant message is part of a heartbeat turn. */
  isHeartbeatAssistant(message: Record<string, unknown> | undefined): boolean {
    if (this.inHeartbeat) {
      return true;
    }
    return isHeartbeatAckText(transcriptMessageText(message));
  }
}

export const HEARTBEAT_CHANNEL = "heartbeat";

export type TtlMemo = Map<string, "5m" | "1h" | "none" | undefined>;

/**
 * Prompt-cache TTL label for a reconciled row. Transcripts carry no TTL and pi-ai (0.52.x) does
 * not surface Anthropic's `cache_creation.ephemeral_{5m,1h}_input_tokens` split, so the label
 * is the configured retention for that provider/model at reconcile time.
 */
export function cacheTtlFor(
  memo: TtlMemo,
  cfg: BitterbotConfig | undefined,
  provider: string | undefined,
  model: string | undefined,
): "5m" | "1h" | "none" | undefined {
  if (!provider || !model) {
    return undefined;
  }
  const key = `${provider}/${model}`;
  if (!memo.has(key)) {
    let label: "5m" | "1h" | "none" | undefined;
    try {
      label = resolveCacheTtlLabel({ cfg, provider, modelId: model });
    } catch {
      label = undefined;
    }
    memo.set(key, label);
  }
  return memo.get(key);
}
