/**
 * PLAN-52 Phase 3: conversation serialization and file-operation tracking for
 * summary compaction.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/compaction/utils.js`: `createFileOps`, `extractFileOpsFromMessage`,
 * `computeFileLists`, `formatFileOperations`, `serializeConversation` and the
 * tool-result truncation. The serialized text is part of the summarization
 * prompt, so labels, separators and the truncation marker must stay
 * byte-identical.
 *
 * Differences from the original: typing only. (`SUMMARIZATION_SYSTEM_PROMPT`,
 * which pi keeps in the same file, is in `summarize.ts` with the other
 * prompts.)
 *
 * Kept as in pi, on purpose:
 * - Only tool calls named exactly `read`, `write` and `edit` with a string
 *   `path` argument count as file operations.
 * - A file that was read and also written or edited is listed as modified
 *   only.
 * - Images are left out of the serialized text; a message with no text
 *   produces no line.
 * - Tool results are cut at 2000 chars; user and assistant text is not cut.
 */
import type { Message, TextContent } from "@mariozechner/pi-ai";
import type { SessionMessage } from "./messages.js";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

/** Add the file operations of the tool calls in an assistant message. */
export function extractFileOpsFromMessage(message: SessionMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") {
    return;
  }
  const content: unknown = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const item of content as unknown[]) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const block = item as { type?: unknown; name?: unknown; arguments?: unknown };
    if (!("type" in block) || block.type !== "toolCall") {
      continue;
    }
    if (!("arguments" in block) || !("name" in block)) {
      continue;
    }
    const args = block.arguments as Record<string, unknown> | null | undefined;
    if (!args) {
      continue;
    }
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
      default:
        break;
    }
  }
}

/**
 * Final file lists, both sorted: `readFiles` holds the files that were only
 * read, `modifiedFiles` the files that were written or edited.
 */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

/** The file lists as the tagged block appended to a summary ("" when both are empty). */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/** Maximum characters of one tool result in the serialized conversation. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Keep the first `maxChars` characters and say how many were dropped. */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to plain text for the summarization prompt, so the
 * model does not treat them as a conversation to continue. Call
 * `convertToLlm` first to resolve the custom roles.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("");
      if (content) {
        parts.push(`[User]: ${content}`);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }
  return parts.join("\n\n");
}
