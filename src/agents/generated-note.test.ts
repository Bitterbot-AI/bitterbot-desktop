import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  annotateGeneratedNotes,
  GENERATED_NOTE_FIELD,
  GENERATED_NOTE_PREFIX,
  isGeneratedNoteMessage,
} from "./generated-note.js";

const OFFER =
  "You have asked for npm downloads after repo clone metrics twice. Include it every time? (yes / no)";

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
    ...extra,
  }) as unknown as AgentMessage;

describe("annotateGeneratedNotes", () => {
  it("marks a generated note in the model's view and leaves the stored message alone", () => {
    const answer = assistant("Clones yesterday: 68.");
    const note = assistant(OFFER, { [GENERATED_NOTE_FIELD]: true });
    const user = { role: "user", content: "yes", timestamp: 2 } as unknown as AgentMessage;
    const messages = [answer, note, user];
    const out = annotateGeneratedNotes(messages);
    expect(out[0]).toBe(answer);
    expect(out[2]).toBe(user);
    const text = (out[1] as unknown as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe(`${GENERATED_NOTE_PREFIX}\n${OFFER}`);
    expect(text).toContain("You did not write it.");
    expect(text).toContain("Do not repeat it, re-ask it");
    // The transcript's own object keeps the plain line (what the UI shows).
    expect((note as unknown as { content: Array<{ text: string }> }).content[0]!.text).toBe(OFFER);
    // Idempotent: a second pass adds nothing.
    expect(annotateGeneratedNotes(out)).toBe(out);
  });

  it("returns the same array when there is no note, and handles string content", () => {
    const messages = [assistant("Clones yesterday: 68.")];
    expect(annotateGeneratedNotes(messages)).toBe(messages);
    const note = {
      role: "assistant",
      content: OFFER,
      [GENERATED_NOTE_FIELD]: true,
    } as unknown as AgentMessage;
    const out = annotateGeneratedNotes([note]);
    expect((out[0] as unknown as { content: string }).content).toBe(
      `${GENERATED_NOTE_PREFIX}\n${OFFER}`,
    );
  });

  it("only an assistant message with the field set to true is a note", () => {
    expect(isGeneratedNoteMessage(assistant(OFFER, { [GENERATED_NOTE_FIELD]: true }))).toBe(true);
    expect(isGeneratedNoteMessage(assistant(OFFER))).toBe(false);
    expect(isGeneratedNoteMessage(assistant(OFFER, { [GENERATED_NOTE_FIELD]: "true" }))).toBe(
      false,
    );
    expect(
      isGeneratedNoteMessage({ role: "user", content: OFFER, [GENERATED_NOTE_FIELD]: true }),
    ).toBe(false);
    expect(isGeneratedNoteMessage(null)).toBe(false);
  });
});
