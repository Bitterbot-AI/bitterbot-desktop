/**
 * Token estimate for the offload policy. Mirrors pi's `estimateTokens`
 * (chars/4 over text, thinking, tool-call name + JSON arguments, tool-result
 * text; tool-result images at 1,200 tokens) and adds the one case pi ignores:
 * images in user content, counted at 1,500 tokens each (PLAN-52A 3.2).
 */

export const USER_IMAGE_TOKENS = 1_500;
export const TOOL_RESULT_IMAGE_TOKENS = 1_200;

type Block = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  arguments?: unknown;
};

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Estimate tokens for one pi v3 `message` payload (`entry.message`). */
export function estimateMessageTokens(message: { role?: unknown; content?: unknown }): {
  tokens: number;
  images: number;
} {
  let chars = 0;
  let images = 0;
  const role = message.role;
  const content = message.content;
  if (typeof content === "string") {
    chars = content.length;
    return { tokens: Math.ceil(chars / 4), images: 0 };
  }
  for (const block of blocksOf(content)) {
    if (!block || typeof block !== "object") {
      continue;
    }
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          chars += block.text.length;
        }
        break;
      case "thinking":
        if (typeof block.thinking === "string") {
          chars += block.thinking.length;
        }
        break;
      case "toolCall":
        if (typeof block.name === "string") {
          chars += block.name.length;
        }
        chars += safeJsonLength(block.arguments);
        break;
      case "image":
        images++;
        break;
      default:
        break;
    }
  }
  let tokens = Math.ceil(chars / 4);
  if (images > 0) {
    tokens += images * (role === "user" ? USER_IMAGE_TOKENS : TOOL_RESULT_IMAGE_TOKENS);
  }
  return { tokens, images };
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}

/** Text-only estimate (ledger text, stub markers). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
