/**
 * Expand Message Tool
 *
 * When progressive compression truncates message content, it stores
 * the original and embeds a fingerprint reference. This tool lets
 * the agent retrieve the full original content by reference.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { getOriginalContent, getTruncatedOriginalsSize } from "../progressive-compression.js";

const ExpandMessageToolSchema = Type.Object({
  reference: Type.String({
    description:
      "The reference fingerprint shown in the truncation notice (e.g., 'a1b2c3d4e5f6')",
  }),
});

export function createExpandMessageTool(): AnyAgentTool {
  return {
    label: "Expand Message",
    name: "expand_message",
    description:
      "Retrieve the full content of a truncated message. Use when you see '[Content truncated. Reference: xxx]' in the conversation history.",
    parameters: ExpandMessageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const reference =
        typeof params.reference === "string" ? params.reference.trim() : "";

      if (!reference) {
        return {
          content: [
            {
              type: "text",
              text: "Error: reference parameter is required. Look for '[Content truncated. Reference: xxx]' in the conversation.",
            },
          ],
          details: { ok: false, error: "missing_reference" },
        };
      }

      const original = getOriginalContent(reference);

      if (!original) {
        return {
          content: [
            {
              type: "text",
              text: `Original content not available for reference "${reference}". It may have been from a previous session or evicted from the cache (max ${getTruncatedOriginalsSize()} stored).`,
            },
          ],
          details: { ok: false, error: "not_found", reference },
        };
      }

      return {
        content: [{ type: "text", text: original }],
        details: { ok: true, reference, length: original.length },
      };
    },
  };
}
