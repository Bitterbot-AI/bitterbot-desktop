import { escapeRegExp } from "../utils.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/**
 * Placeholder lines that say "there is nothing to do" in prose. The live
 * HEARTBEAT.md that cost $16/idle day (token-efficiency review 2026-09-19)
 * carried exactly one such line, wrapped in italics, and the old check
 * treated it as an actionable task. Matched after emphasis wrappers are
 * stripped, case-insensitive, and only when the placeholder is the whole
 * line: "No pending tasks except: ping ops" is still a task.
 */
const HEARTBEAT_PLACEHOLDER_RE =
  /^(no (active|pending) (heartbeat )?tasks?|nothing (to do|needs attention))( (right now|yet|currently|today))?[.!]*(\s+if nothing needs attention,? reply heartbeat_ok[.!]*)?$/i;

/**
 * Sentences from the shipped template / default prompt that carry no task.
 * Compared after emphasis stripping and trailing-punctuation normalization.
 */
const HEARTBEAT_TEMPLATE_SENTENCES = new Set(
  [
    "Keep this file empty (or with only comments) to skip heartbeat API calls",
    "Add tasks below when you want the agent to check something periodically",
    "If nothing needs attention, reply HEARTBEAT_OK",
    "No active heartbeat tasks. If nothing needs attention, reply HEARTBEAT_OK",
  ].map((line) => line.toLowerCase()),
);

/** Strip leading/trailing markdown emphasis wrappers (`_`, `*`, `~`, backticks). */
function stripEmphasisWrappers(line: string): string {
  return line
    .replace(/^[_*~`]+/, "")
    .replace(/[_*~`]+$/, "")
    .trim();
}

/**
 * Remove HTML comments (single or multi-line) and fenced code blocks before
 * the line scan. Both are non-actionable by construction: comments are hidden
 * from the reader and fences in a heartbeat checklist are examples, not tasks.
 */
function stripNonActionableBlocks(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "\n");
}

/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace
 * - Markdown header lines (`# ...`)
 * - Empty list items (`- `, `- [ ]`)
 * - HTML comments (`<!-- ... -->`, possibly spanning lines)
 * - Fenced code blocks
 * - Horizontal rules (`---`, `***`, `___`)
 * - Placeholder prose such as `_No active heartbeat tasks._` or `Nothing to do`
 * - The template / default-prompt sentences ("If nothing needs attention, reply HEARTBEAT_OK.")
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = stripNonActionableBlocks(content).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL, ## etc)
    // This intentionally does NOT skip lines like "#TODO" or "#hashtag" which might be content
    // (Those aren't valid markdown headers - ATX headers require space after #)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    // Skip horizontal rules.
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      continue;
    }
    // Skip placeholder prose and template sentences (possibly emphasis-wrapped,
    // possibly a list item wrapping them).
    const unwrapped = stripEmphasisWrappers(trimmed.replace(/^[-*+]\s+(\[[\sXx]?\]\s*)?/, ""));
    if (HEARTBEAT_PLACEHOLDER_RE.test(unwrapped)) {
      continue;
    }
    const sentence = unwrapped.replace(/[.!\s]+$/, "").toLowerCase();
    if (HEARTBEAT_TEMPLATE_SENTENCES.has(sentence)) {
      continue;
    }
    // Found a non-empty, non-comment line - there's actionable content
    return false;
  }
  // All lines were either empty or comments
  return true;
}

export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || HEARTBEAT_PROMPT;
}

export type StripHeartbeatMode = "heartbeat" | "message";

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      // Drop HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common nbsp variant.
      .replace(/&nbsp;/gi, " ")
      // Remove markdown-ish wrappers at the edges.
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}
