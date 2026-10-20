/**
 * PLAN-52 Phase 3: session message roles and their conversion to LLM messages.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/messages.js`: the four custom roles (`bashExecution`, `custom`,
 * `branchSummary`, `compactionSummary`), their wrapper texts, and
 * `convertToLlm`. The wrapper texts must stay byte-identical: they are what
 * the model sees for a compacted or branched session.
 *
 * Differences from the original:
 *
 * 1. The custom roles are plain interfaces joined in `SessionMessage`. pi
 *    registers them by declaration merging on pi-agent-core's
 *    `CustomAgentMessages`; the shapes are the same, so the types are mutually
 *    assignable with pi's `AgentMessage`.
 * 2. The `create*Message` helpers are not repeated here; they live with the
 *    transcript port in `../../transcript/context.ts`.
 * 3. `toSessionMessage` is new: the transcript store keeps message payloads
 *    opaque (`TranscriptMessage`), this is the one place they are typed.
 */
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import type { TranscriptMessage } from "../../transcript/types.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** A bash execution started by the user (the `!` command). */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  /** If true, the message is left out of the LLM context (the `!!` prefix). */
  excludeFromContext?: boolean;
}

/** A message injected by an extension; it reaches the model as a user message. */
export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** LLM messages plus the four session roles. Same members as pi's `AgentMessage`. */
export type SessionMessage =
  | Message
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

/**
 * Type a stored message payload. No validation: like pi, the session layer
 * trusts what the transcript holds.
 */
export function toSessionMessage(message: TranscriptMessage): SessionMessage {
  return message as unknown as SessionMessage;
}

/** Convert a bash execution to the user message text the model sees. */
export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/**
 * Turn session messages into LLM messages. Custom roles become user messages;
 * a bash execution marked `excludeFromContext` and any unknown role are
 * dropped; user, assistant and tool result messages pass through by reference.
 */
export function convertToLlm(messages: readonly SessionMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "bashExecution":
        if (m.excludeFromContext) {
          break;
        }
        out.push({
          role: "user",
          content: [{ type: "text", text: bashExecutionToText(m) }],
          timestamp: m.timestamp,
        });
        break;
      case "custom": {
        const content: (TextContent | ImageContent)[] =
          typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
        out.push({ role: "user", content, timestamp: m.timestamp });
        break;
      }
      case "branchSummary":
        out.push({
          role: "user",
          content: [
            { type: "text", text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX },
          ],
          timestamp: m.timestamp,
        });
        break;
      case "compactionSummary":
        out.push({
          role: "user",
          content: [
            {
              type: "text",
              text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX,
            },
          ],
          timestamp: m.timestamp,
        });
        break;
      case "user":
      case "assistant":
      case "toolResult":
        out.push(m);
        break;
      default:
        // A role this port does not know (possible in a stored transcript).
        break;
    }
  }
  return out;
}
