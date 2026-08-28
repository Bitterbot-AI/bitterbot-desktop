/**
 * Strip markdown formatting from text (for plain text output).
 * Handles: bold, italic, strikethrough, headers, blockquotes, horizontal
 * rules, inline code.
 *
 * Relocated from the deleted LINE channel's markdown converter
 * (PLAN-41 p0-24) — the TTS pipeline and plugin SDK were importing a
 * channel-agnostic utility out of channel-specific code.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");

  // Remove italic: *text* or _text_ (but not already processed)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");

  // Remove strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Remove headers: # Title, ## Title, etc.
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Remove blockquotes: > text
  result = result.replace(/^>\s?(.*)$/gm, "$1");

  // Remove horizontal rules: ---, ***, ___
  result = result.replace(/^[-*_]{3,}$/gm, "");

  // Remove inline code: `code`
  result = result.replace(/`([^`]+)`/g, "$1");

  // Clean up extra whitespace
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();

  return result;
}
