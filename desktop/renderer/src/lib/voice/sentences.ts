/**
 * Cut a streaming reply into sentences to speak as they arrive (PLAN-53 F3),
 * so the agent starts talking before it has finished writing.
 */

/** Markdown that should be heard as plain words, or not at all. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\s+/g, " ")
    .trim();
}

const BOUNDARY = /([.!?…]+["')\]]?)(\s+|$)|\n{2,}/g;

/**
 * Whole sentences from `text`, plus the unfinished rest. An open code block
 * holds everything after it until it closes. Very short pieces are joined to
 * the next so speech does not stutter.
 */
export function takeSentences(text: string, minChars = 24): { sentences: string[]; rest: string } {
  const fences = text.match(/```/g)?.length ?? 0;
  let cut = text;
  let held = "";
  if (fences % 2 === 1) {
    const open = text.lastIndexOf("```");
    cut = text.slice(0, open);
    held = text.slice(open);
  }
  const sentences: string[] = [];
  let start = 0;
  let pending = "";
  for (const m of cut.matchAll(BOUNDARY)) {
    const end = (m.index ?? 0) + m[0].length;
    // Only a boundary followed by whitespace (or a paragraph break) is final.
    if (m[2] === "" && !m[0].startsWith("\n")) continue;
    const piece = pending + cut.slice(start, end);
    start = end;
    if (speakable(piece).length < minChars) {
      pending = piece;
      continue;
    }
    pending = "";
    const spoken = speakable(piece);
    if (spoken) sentences.push(spoken);
  }
  return { sentences, rest: pending + cut.slice(start) + held };
}
