/**
 * End-to-end wiring test for the memory-fence scrubber.
 *
 * Lives in src/agents/streaming-context-scrubber.test.ts proves the FSM
 * itself; this file proves the FSM is actually applied inside
 * subscribeEmbeddedPiSession when memoryFenceWrapping is on, and is a
 * no-op when it is off.
 */

import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

function makeSession(): { session: StubSession; emit: (evt: unknown) => void } {
  let handler: ((evt: unknown) => void) | undefined;
  const session: StubSession = {
    subscribe: (fn) => {
      handler = fn;
      return () => {};
    },
  };
  return {
    session,
    emit: (evt) => handler?.(evt),
  };
}

describe("subscribeEmbeddedPiSession — memory-fence scrubber wiring", () => {
  it("is a pass-through when memoryFenceWrapping is off (default)", () => {
    const { session, emit } = makeSession();
    const onPartialReply = vi.fn();
    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello <memory-context>SECRET</memory-context> world",
      },
    });

    // When the flag is off, the scrubber is the identity function — content
    // is forwarded verbatim. (The scrubber does not exist on this code path
    // at all; the no-op fast-paths in subscribe.ts skip the per-chunk
    // allocation entirely.)
    expect(onPartialReply).toHaveBeenCalled();
    const seenText = onPartialReply.mock.calls.map((c) => (c[0] as { text?: string }).text ?? "");
    expect(seenText.some((t) => t.includes("SECRET"))).toBe(true);
  });

  it("strips a complete span in one delta when memoryFenceWrapping is on", () => {
    const { session, emit } = makeSession();
    const onPartialReply = vi.fn();
    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onPartialReply,
      memoryFenceWrapping: true,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello <memory-context>SECRET-FROM-PROMPT</memory-context> world",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const seenText = onPartialReply.mock.calls.map((c) => (c[0] as { text?: string }).text ?? "");
    // The fenced content must never appear in any forwarded delta.
    expect(seenText.some((t) => t.includes("SECRET-FROM-PROMPT"))).toBe(false);
    // The non-fenced text on either side should still come through.
    const concatenated = seenText.join("");
    expect(concatenated).toContain("hello");
    expect(concatenated).toContain("world");
  });

  it("strips a fence span split across chunk boundaries", () => {
    const { session, emit } = makeSession();
    const onPartialReply = vi.fn();
    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onPartialReply,
      memoryFenceWrapping: true,
    });

    emit({ type: "message_start", message: { role: "assistant" } });

    const stream = "before<memory-context>HIDDEN</memory-context>after";
    // Feed the string one character at a time. The scrubber must hold back
    // any partial-tag suffix at every boundary.
    for (const ch of stream) {
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: ch,
        },
      });
    }

    const seenText = onPartialReply.mock.calls.map((c) => (c[0] as { text?: string }).text ?? "");
    expect(seenText.some((t) => t.includes("HIDDEN"))).toBe(false);
    expect(seenText.some((t) => t.includes("memory-context"))).toBe(false);
    const concatenated = seenText.join("");
    expect(concatenated).toContain("before");
    expect(concatenated).toContain("after");
  });

  it("discards the held buffer on text_end mid-span (no leak on EOS)", () => {
    const { session, emit } = makeSession();
    const onPartialReply = vi.fn();
    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onPartialReply,
      memoryFenceWrapping: true,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "ok <memory-context>UNCLOSED-SECRET",
      },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    const seenText = onPartialReply.mock.calls.map((c) => (c[0] as { text?: string }).text ?? "");
    // mid-span EOS: the held buffer is dropped rather than emitted as a
    // partial leak. Only the pre-fence "ok " should ever show up.
    expect(seenText.some((t) => t.includes("UNCLOSED-SECRET"))).toBe(false);
  });
});
