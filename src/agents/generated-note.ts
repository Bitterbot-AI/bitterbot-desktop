/**
 * System-generated one-line notes in a session transcript.
 *
 * On the desktop and webchat surface the turn's generated line ("Memory
 * updated", a practice offer, "Practice saved", "Applied: ...") is stored as
 * a short assistant message of its own, right after the answer, so the owner
 * sees it live and after a reload. The stored text is the line as shown; the
 * message carries `GENERATED_NOTE_FIELD` so nothing mistakes it for model
 * output.
 *
 * The model reads the transcript too. Left as is, the note would look like
 * its own earlier words, and it would repeat the question, re-announce the
 * confirmation or start writing such lines itself. `annotateGeneratedNotes`
 * marks the note in the model's view only (the transcript and the UI keep the
 * plain line).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Set to `true` on a transcript message that is a system-generated note. */
export const GENERATED_NOTE_FIELD = "bitterbotGeneratedNote";

export const GENERATED_NOTE_PREFIX =
  "[System note shown to the owner after your reply. You did not write it. Do not repeat it, re-ask it, answer it or write lines like it.]";

export function isGeneratedNoteMessage(message: unknown): boolean {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "assistant" &&
    (message as Record<string, unknown>)[GENERATED_NOTE_FIELD] === true
  );
}

/**
 * Prefix the text of every generated note with `GENERATED_NOTE_PREFIX`, for
 * the model's view of the history. Returns the same array when there is
 * nothing to mark; never mutates a message.
 */
export function annotateGeneratedNotes(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((msg) => {
    if (!isGeneratedNoteMessage(msg)) {
      return msg;
    }
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      if (content.startsWith(GENERATED_NOTE_PREFIX)) {
        return msg;
      }
      touched = true;
      return {
        ...(msg as unknown as Record<string, unknown>),
        content: `${GENERATED_NOTE_PREFIX}\n${content}`,
      } as unknown as AgentMessage;
    }
    if (!Array.isArray(content)) {
      return msg;
    }
    const index = content.findIndex(
      (block: unknown) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );
    if (index < 0) {
      return msg;
    }
    const block = content[index] as { type: "text"; text: string };
    if (block.text.startsWith(GENERATED_NOTE_PREFIX)) {
      return msg;
    }
    touched = true;
    const next = content.slice();
    next[index] = { ...block, text: `${GENERATED_NOTE_PREFIX}\n${block.text}` };
    return {
      ...(msg as unknown as Record<string, unknown>),
      content: next,
    } as unknown as AgentMessage;
  });
  return touched ? out : messages;
}
