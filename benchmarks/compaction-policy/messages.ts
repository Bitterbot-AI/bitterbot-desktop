/**
 * Transcript entries -> Anthropic Messages API params, with stubs applied.
 * Pure; exported for tests.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { renderToolStubMarker } from "../../src/agents/runtime/compaction/cut.js";
import type { PolicyEntry, StubKind } from "../../src/agents/runtime/compaction/types.js";

type Block = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };

/** The raw pi message content for an entry id (needed for tool_use blocks). */
export type RawMessageLookup = (
  entryId: string,
) => { role?: string; content?: unknown } | undefined;

/**
 * Convert path entries to API messages. Stubbed tool outputs become the stub
 * marker; stubbed heartbeat pairs are dropped; thinking blocks are dropped.
 * Consecutive tool results are grouped into one user message so every
 * tool_result follows its tool_use.
 */
export function entriesToMessages(
  entries: readonly PolicyEntry[],
  stubbed: ReadonlyMap<string, StubKind>,
  raw: RawMessageLookup,
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];
  const flushResults = () => {
    if (pendingResults.length) {
      out.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };
  for (const e of entries) {
    const kind = stubbed.get(e.id);
    if (kind === "heartbeat_pair") {
      continue;
    }
    if (e.role === "toolResult") {
      const text =
        kind === "tool_result"
          ? renderToolStubMarker({ toolName: e.toolName, chars: e.text.length, entryId: e.id })
          : e.text || "(empty tool output)";
      pendingResults.push({
        type: "tool_result",
        tool_use_id: e.toolCallId ?? `missing-${e.id}`,
        content: text,
      });
      continue;
    }
    flushResults();
    if (e.role === "user") {
      out.push({ role: "user", content: e.text || "(empty)" });
      continue;
    }
    // assistant: text + tool_use blocks from the raw content
    const blocks: Anthropic.ContentBlockParam[] = [];
    const rawMsg = raw(e.id);
    const content = Array.isArray(rawMsg?.content) ? (rawMsg!.content as Block[]) : [];
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "toolCall" && b.id && b.name) {
        blocks.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: (b.arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (blocks.length === 0) {
      blocks.push({ type: "text", text: e.text || "(no text)" });
    }
    out.push({ role: "assistant", content: blocks });
  }
  flushResults();
  // The API requires the first message to be from the user.
  if (out.length && out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "(conversation resumes)" });
  }
  return out;
}

/** pi's wrapper for the compaction summary as the model sees it. */
export function compactionWrapper(summary: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
  };
}

/** Text form of a range for summarisers and probe generation. */
export function serializeEntries(
  entries: readonly PolicyEntry[],
  opts: { toolMaxChars: number; withIds: boolean },
): string {
  const parts: string[] = [];
  for (const e of entries) {
    const addr = opts.withIds ? `e${e.id} L${e.line} t${e.turn} ` : "";
    if (e.role === "toolResult") {
      const t =
        e.text.length > opts.toolMaxChars
          ? `${e.text.slice(0, opts.toolMaxChars)} [... ${e.text.length - opts.toolMaxChars} more chars]`
          : e.text;
      parts.push(`${addr}[Tool ${e.toolName ?? "tool"}]: ${t}`);
    } else if (e.role === "user") {
      parts.push(`${addr}[User]: ${e.text}`);
    } else {
      const calls = e.toolCallIds.length ? ` (tool calls: ${e.toolCallIds.length})` : "";
      parts.push(`${addr}[Assistant]${calls}: ${e.text}`);
    }
  }
  return parts.join("\n\n");
}
