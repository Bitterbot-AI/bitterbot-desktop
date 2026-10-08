/**
 * PLAN-52 Phase 0: harness for the runtime contract suite.
 *
 * A contract session is one agent session wired the way the embedded runner
 * wires it (transcript store + tool-result guard, system prompt, sequential
 * tools with steering skip, request auth), driven by a scripted model. The
 * harness records every session event and reads back the transcript, both
 * normalized (random ids renamed in order of appearance, clocks blanked), so
 * a run can be compared line for line with the committed golden.
 *
 * The goldens were recorded on the pi engine before it was removed (Phase 6);
 * the one variant left, "bitterbot", is held to them.
 */

import fs from "node:fs";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { OffloadPolicySettings } from "../compaction/offload-policy.js";
import { createOwnedContractSession } from "./owned-session.js";
import type { ScriptedModel } from "./scripted-model.js";

export type ContractVariant = "bitterbot";

export { CONTRACT_API_KEY, CONTRACT_SESSION_ID } from "./scripted-model.js";

export type ContractOptions = {
  variant: ContractVariant;
  /** Scratch directory (workspace, agent dir, and transcript live here). */
  dir: string;
  script: ScriptedModel;
  tools?: AgentTool[];
  systemPrompt?: string;
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  /** Use the offload compaction policy with these settings. */
  offload?: {
    settings?: Partial<OffloadPolicySettings>;
    summaryMode?: "off" | "idle" | "always";
    /** Prompts that count as a heartbeat (for heartbeat-pair elision). */
    heartbeatPrompts?: string[];
  };
};

/** The session surface the embedded runner uses, engine-independent. */
export type SessionLike = {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly messages: AgentMessage[];
  readonly agent: { waitForIdle(): Promise<void> };
};

export type ContractSession = {
  variant: ContractVariant;
  file: string;
  /** Normalized session events, in emission order. */
  events: string[];
  session: SessionLike;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  /** Wait until the session is idle and has stopped emitting events. */
  settle(): Promise<void>;
  /** Normalized in-memory messages. */
  messages(): string[];
  /** Normalized transcript lines, or [] when no file was written. */
  transcript(): string[];
  dispose(): Promise<void>;
};

// ── normalization ────────────────────────────────────────────────────────

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      out += b.text;
    } else if (b.type === "image") {
      out += "<image>";
    }
  }
  return out;
}

/** One-line description of a message, stable across engines. */
export function describeMessage(message: unknown): string {
  const m = (message ?? {}) as {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    summary?: string;
    customType?: string;
  };
  switch (m.role) {
    case "user":
      return `user ${JSON.stringify(textOf(m.content))}`;
    case "assistant": {
      const calls = Array.isArray(m.content)
        ? m.content
            .filter((b) => (b as { type?: string }).type === "toolCall")
            .map((b) => {
              const call = b as { name?: string; id?: string };
              return `${call.name}#${call.id}`;
            })
        : [];
      return (
        `assistant[${m.stopReason ?? "?"}] ${JSON.stringify(textOf(m.content))}` +
        (calls.length > 0 ? ` calls=[${calls.join(",")}]` : "") +
        (m.errorMessage ? ` error=${JSON.stringify(m.errorMessage)}` : "")
      );
    }
    case "toolResult":
      return `toolResult ${m.toolName}#${m.toolCallId} isError=${m.isError === true} ${JSON.stringify(textOf(m.content))}`;
    case "compactionSummary":
      return `compactionSummary ${JSON.stringify(m.summary ?? "")}`;
    case "branchSummary":
      return `branchSummary ${JSON.stringify(m.summary ?? "")}`;
    case "custom":
      return `custom:${m.customType ?? "?"} ${JSON.stringify(textOf(m.content))}`;
    default:
      return m.role ?? "unknown";
  }
}

/** One-line description of a session event. */
export function describeEvent(event: unknown): string {
  const e = (event ?? {}) as Record<string, unknown> & { type?: string };
  switch (e.type) {
    case "message_start":
    case "message_end":
      return `${e.type} ${describeMessage(e.message)}`;
    case "message_update": {
      const inner = e.assistantMessageEvent as { type?: string } | undefined;
      return `message_update ${inner?.type ?? "?"}`;
    }
    case "turn_end": {
      const results = Array.isArray(e.toolResults) ? e.toolResults.length : 0;
      return `turn_end toolResults=${results}`;
    }
    case "tool_execution_start":
      return `tool_execution_start ${String(e.toolName)}#${String(e.toolCallId)} args=${JSON.stringify(e.args)}`;
    case "tool_execution_update":
      return `tool_execution_update ${String(e.toolName)}#${String(e.toolCallId)}`;
    case "tool_execution_end": {
      const result = e.result as { content?: unknown } | undefined;
      return `tool_execution_end ${String(e.toolName)}#${String(e.toolCallId)} isError=${e.isError === true} ${JSON.stringify(textOf(result?.content))}`;
    }
    case "queue_update":
      return `queue_update steering=${JSON.stringify(e.steering ?? [])} followUp=${JSON.stringify(e.followUp ?? [])}`;
    case "compaction_start":
      return `compaction_start ${String(e.reason)}`;
    case "compaction_end":
      return (
        `compaction_end ${String(e.reason)} result=${e.result ? "yes" : "no"} aborted=${e.aborted === true} willRetry=${e.willRetry === true}` +
        (e.errorMessage ? ` error=${JSON.stringify(e.errorMessage)}` : "")
      );
    case "auto_retry_start":
      return `auto_retry_start attempt=${String(e.attempt)}/${String(e.maxAttempts)} delayMs=${String(e.delayMs)} error=${JSON.stringify(e.errorMessage)}`;
    case "auto_retry_end":
      return (
        `auto_retry_end success=${e.success === true} attempt=${String(e.attempt)}` +
        (e.finalError ? ` finalError=${JSON.stringify(e.finalError)}` : "")
      );
    default:
      return String(e.type ?? "unknown");
  }
}

const ID_KEYS = new Set(["id", "parentId", "firstKeptEntryId", "targetId", "fromId"]);

/** Normalized transcript lines: ids renamed by first appearance, clocks and cwd blanked. */
export function normalizeTranscript(file: string): string[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const ids = new Map<string, string>();
  const walk = (value: unknown, key?: string, inMessage = false): unknown => {
    if (typeof value === "string") {
      if (!inMessage && key && ID_KEYS.has(key) && value !== "root") {
        if (!ids.has(value)) {
          ids.set(value, `#${ids.size}`);
        }
        return ids.get(value);
      }
      if (key === "timestamp") {
        return "TS";
      }
      if (key === "cwd") {
        return "CWD";
      }
      return value;
    }
    if (typeof value === "number" && key === "timestamp") {
      return 0;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, undefined, inMessage));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(value)) {
        out[k] = walk(child, k, inMessage || k === "message");
      }
      return out;
    }
    return value;
  };
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.stringify(walk(JSON.parse(line))));
}

// ── session construction ─────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function createContractSession(options: ContractOptions): Promise<ContractSession> {
  const file = `${options.dir}/session.jsonl`;
  const session = await createOwnedContractSession(options, file);
  const events: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    events.push(describeEvent(event));
  });

  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    let quiet = 0;
    let last = -1;
    while (Date.now() < deadline) {
      await sleep(25);
      const busy = session.isStreaming || session.isCompacting;
      if (!busy && events.length === last) {
        quiet += 1;
        // 10 x 25 ms of silence covers the 100 ms delay before a post-compaction retry.
        if (quiet >= 10) {
          return;
        }
      } else {
        quiet = 0;
      }
      last = events.length;
    }
    throw new Error(`contract session (${options.variant}) did not settle`);
  };

  return {
    variant: options.variant,
    file,
    events,
    session,
    prompt: (text) => session.prompt(text),
    steer: (text) => session.steer(text),
    abort: () => session.abort(),
    compact: (customInstructions) => session.compact(customInstructions),
    settle,
    messages: () => session.messages.map((m) => describeMessage(m)),
    transcript: () => normalizeTranscript(file),
    dispose: async () => {
      await session.agent.waitForIdle();
      unsubscribe();
      session.dispose();
    },
  };
}
