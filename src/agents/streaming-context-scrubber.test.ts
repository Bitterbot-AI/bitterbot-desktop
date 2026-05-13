import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FENCE,
  partialPrefixSuffixStart,
  scrubContextOnce,
  StreamingContextScrubber,
} from "./streaming-context-scrubber.js";

const OPT = DEFAULT_MEMORY_FENCE;

function feedAll(s: StreamingContextScrubber, chunks: string[]): { out: string; tail: string } {
  let out = "";
  for (const chunk of chunks) {
    out += s.feed(chunk);
  }
  const tail = s.flush();
  return { out, tail };
}

describe("partialPrefixSuffixStart", () => {
  it("returns buf.length when there is no overlap", () => {
    expect(partialPrefixSuffixStart("hello", "<tag>")).toBe(5);
  });
  it("returns the index of the matching suffix prefix", () => {
    expect(partialPrefixSuffixStart("hello<m", "<memory>")).toBe(5);
    expect(partialPrefixSuffixStart("hello<me", "<memory>")).toBe(5);
    expect(partialPrefixSuffixStart("<mem", "<memory>")).toBe(0);
  });
  it("only finds proper-prefix overlaps; a full-tag buffer reports no partial match", () => {
    // The full tag in buf is detected by the caller's indexOf path, not by
    // this helper, which only searches for proper-prefix suffixes (length
    // strictly < needle.length). "<memory>" has no proper prefix that is
    // also a suffix of "<memory>", so the helper reports buf.length.
    expect(partialPrefixSuffixStart("<memory>", "<memory>")).toBe(8);
  });
  it("handles empty needle", () => {
    expect(partialPrefixSuffixStart("hello", "")).toBe(5);
  });
});

describe("StreamingContextScrubber — single-chunk", () => {
  it("passes through plain text untouched", () => {
    const s = new StreamingContextScrubber(OPT);
    expect(s.feed("hello world")).toBe("hello world");
    expect(s.flush()).toBe("");
  });

  it("strips a complete span in one shot", () => {
    const s = new StreamingContextScrubber(OPT);
    expect(s.feed("before<memory-context>middle</memory-context>after")).toBe("beforeafter");
    expect(s.flush()).toBe("");
  });

  it("strips multiple spans", () => {
    const s = new StreamingContextScrubber(OPT);
    expect(s.feed("a<memory-context>X</memory-context>b<memory-context>Y</memory-context>c")).toBe(
      "abc",
    );
  });

  it("is case-insensitive by default", () => {
    const s = new StreamingContextScrubber(OPT);
    expect(s.feed("a<Memory-Context>X</MEMORY-CONTEXT>b")).toBe("ab");
  });

  it("respects case-sensitive mode", () => {
    const s = new StreamingContextScrubber({
      ...OPT,
      caseInsensitive: false,
    });
    // Case mismatch on open tag — should pass through.
    const out1 = s.feed("a<Memory-Context>X</Memory-Context>b");
    expect(out1).toBe("a<Memory-Context>X</Memory-Context>b");
  });
});

describe("StreamingContextScrubber — chunk boundaries", () => {
  it("strips a span split across two chunks", () => {
    const s = new StreamingContextScrubber(OPT);
    const { out, tail } = feedAll(s, ["hello<memory-cont", "ext>secret</memory-context>world"]);
    expect(out + tail).toBe("helloworld");
  });

  it("holds back a one-char-at-a-time open tag", () => {
    const s = new StreamingContextScrubber(OPT);
    const stream = "before<memory-context>secret</memory-context>after";
    const chunks = stream.split("");
    const { out, tail } = feedAll(s, chunks);
    expect(out + tail).toBe("beforeafter");
  });

  it("holds back a one-char-at-a-time close tag", () => {
    const s = new StreamingContextScrubber(OPT);
    const { out, tail } = feedAll(s, [
      "before",
      "<memory-context>",
      "se",
      "cret",
      "</",
      "mem",
      "ory",
      "-co",
      "ntext>",
      "after",
    ]);
    expect(out + tail).toBe("beforeafter");
  });

  it("never emits any part of an open tag prefix while holding", () => {
    const s = new StreamingContextScrubber(OPT);
    const emitted = s.feed("hello<memory-c");
    expect(emitted).toBe("hello");
    expect(s.flush()).toBe("<memory-c"); // Not a complete open tag; emit on EOS.
  });

  it("when the partial open tag does not complete, emits it on flush()", () => {
    const s = new StreamingContextScrubber(OPT);
    const emitted = s.feed("hello<memory-c");
    expect(emitted).toBe("hello");
    // No further input arrives — flush emits the held buffer because we
    // were never inside a real span.
    expect(s.flush()).toBe("<memory-c");
  });

  it("discards the buffer when stream ends mid-span", () => {
    const s = new StreamingContextScrubber(OPT);
    const emitted = s.feed("hello<memory-context>secret leak");
    expect(emitted).toBe("hello");
    expect(s.flush()).toBe(""); // discard rather than leak partial span
  });
});

describe("StreamingContextScrubber — adversarial inputs", () => {
  it("handles open tag at the very end of input cleanly", () => {
    const s = new StreamingContextScrubber(OPT);
    const emitted1 = s.feed("body<memory-context>");
    expect(emitted1).toBe("body");
    expect(s.isInSpan).toBe(true);
    // The remainder after the close tag flushes out as part of the second
    // feed (not flush()) because the scrubber continues processing.
    const emitted2 = s.feed("inside</memory-context>more");
    expect(emitted2).toBe("more");
    expect(s.flush()).toBe("");
  });

  it("handles close tag immediately followed by another open tag", () => {
    const s = new StreamingContextScrubber(OPT);
    const out = s.feed("<memory-context>x</memory-context><memory-context>y</memory-context>tail");
    expect(out).toBe("tail");
  });

  it("preserves user text containing only a fence prefix", () => {
    const s = new StreamingContextScrubber(OPT);
    // No closing > so should never enter a span.
    const out = s.feed("here is a string <memory-context that is not a tag");
    expect(s.isInSpan).toBe(false);
    // The trailing "<memory-context" is held back as a potential prefix.
    // The flush should emit it.
    expect(out + s.flush()).toBe("here is a string <memory-context that is not a tag");
  });

  it("does not get confused by a stray closing tag in state A", () => {
    const s = new StreamingContextScrubber(OPT);
    const out = s.feed("ordinary </memory-context> in conversation");
    expect(out + s.flush()).toBe("ordinary </memory-context> in conversation");
  });

  it("reset() returns the scrubber to a fresh state", () => {
    const s = new StreamingContextScrubber(OPT);
    s.feed("<memory-context>x");
    expect(s.isInSpan).toBe(true);
    s.reset();
    expect(s.isInSpan).toBe(false);
    expect(s.feed("plain text")).toBe("plain text");
  });

  it("rejects invalid construction", () => {
    expect(() => new StreamingContextScrubber({ openTag: "", closeTag: "x" })).toThrow();
    expect(() => new StreamingContextScrubber({ openTag: "x", closeTag: "" })).toThrow();
    expect(() => new StreamingContextScrubber({ openTag: "x", closeTag: "x" })).toThrow();
  });

  it("custom tag pair works", () => {
    const s = new StreamingContextScrubber({ openTag: "<<", closeTag: ">>" });
    expect(s.feed("a<<secret>>b")).toBe("ab");
  });

  it("survives a 10kB stream with no tags", () => {
    const s = new StreamingContextScrubber(OPT);
    const text = "x".repeat(10_000);
    expect(s.feed(text) + s.flush()).toBe(text);
  });

  it("survives a 10kB stream with one span", () => {
    const s = new StreamingContextScrubber(OPT);
    const head = "h".repeat(5_000);
    const tail = "t".repeat(5_000);
    expect(s.feed(`${head}<memory-context>SECRET</memory-context>${tail}`) + s.flush()).toBe(
      `${head}${tail}`,
    );
  });
});

describe("scrubContextOnce", () => {
  it("strips complete spans in non-streaming text", () => {
    expect(scrubContextOnce("a<memory-context>b</memory-context>c", OPT)).toBe("ac");
  });
  it("discards trailing unclosed span", () => {
    expect(scrubContextOnce("a<memory-context>b never closes", OPT)).toBe("a");
  });
});
