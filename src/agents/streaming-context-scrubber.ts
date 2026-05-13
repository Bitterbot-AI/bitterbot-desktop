/**
 * Streaming context scrubber for assistant text deltas.
 *
 * Phase 3 of PLAN-15. Hermes wraps every memory-context injection in
 * `<memory-context>...</memory-context>` tags and runs a state-machine
 * scrubber over the model's streaming output to strip any echo of those
 * tags. We don't fence by default today, but adding a guarded scrubber
 * to the pipeline is defense-in-depth: if a future prompt format starts
 * fencing (operator-driven A/B, partner skill, etc.), output sanitisation
 * is already in place across chunk boundaries.
 *
 * Algorithm (Cline-style index-based FSM):
 *
 *   State A — outside a span:
 *     - Append chunk to internal buffer.
 *     - Search buffer for openTag.
 *     - If found: emit text before tag, drop the tag, transition to B,
 *       and recurse on the remainder.
 *     - If not found: emit buffer up to (length - openTag.length + 1).
 *       The trailing slice is the longest prefix of openTag that could
 *       still complete on the next chunk, so we hold it back.
 *
 *   State B — inside a span:
 *     - Append chunk; search for closeTag.
 *     - If found: drop everything through closeTag, transition to A,
 *       recurse on the remainder.
 *     - If not found: hold back the longest closeTag-prefix-suffix in
 *       the buffer (so a split close tag survives the boundary).
 *
 *   flush(): if mid-span at EOS, discard the held buffer (safer than
 *   leaking partial fence). Otherwise emit anything held.
 *
 * The same instance can scrub multiple fence pairs by composition: pass
 * the output of one scrubber into the next.
 */

/**
 * Largest suffix of `buf` that is a prefix of `needle`. Returns the
 * starting index of that suffix in buf. Used to decide how many bytes
 * to hold back at chunk boundaries.
 *
 * Linear-time bounded by min(buf.length, needle.length).
 */
export function partialPrefixSuffixStart(buf: string, needle: string): number {
  if (needle.length === 0) {
    return buf.length;
  }
  const maxOverlap = Math.min(buf.length, needle.length - 1);
  for (let k = maxOverlap; k > 0; k--) {
    if (buf.endsWith(needle.slice(0, k))) {
      return buf.length - k;
    }
  }
  return buf.length;
}

export interface ScrubberOptions {
  /** Opening tag (e.g. "<memory-context>"). Case-sensitive by default. */
  openTag: string;
  /** Closing tag (e.g. "</memory-context>"). */
  closeTag: string;
  /** When true, tag matching is case-insensitive. Defaults to true. */
  caseInsensitive?: boolean;
}

export class StreamingContextScrubber {
  private readonly openTag: string;
  private readonly closeTag: string;
  private readonly caseInsensitive: boolean;
  private readonly openTagCompare: string;
  private readonly closeTagCompare: string;
  private buf = "";
  private inSpan = false;

  constructor(options: ScrubberOptions) {
    if (!options.openTag || !options.closeTag) {
      throw new Error("openTag and closeTag must be non-empty");
    }
    if (options.openTag === options.closeTag) {
      throw new Error("openTag and closeTag must differ");
    }
    this.openTag = options.openTag;
    this.closeTag = options.closeTag;
    this.caseInsensitive = options.caseInsensitive ?? true;
    this.openTagCompare = this.caseInsensitive ? this.openTag.toLowerCase() : this.openTag;
    this.closeTagCompare = this.caseInsensitive ? this.closeTag.toLowerCase() : this.closeTag;
  }

  /** True when the scrubber is currently inside an unclosed fence span. */
  get isInSpan(): boolean {
    return this.inSpan;
  }

  private indexOf(haystack: string, needleCompare: string): number {
    if (this.caseInsensitive) {
      return haystack.toLowerCase().indexOf(needleCompare);
    }
    return haystack.indexOf(needleCompare);
  }

  /**
   * Feed one delta. Returns the portion of the stream that is safe to
   * forward to downstream consumers (UI, persistence). Any text that
   * could be the start of a tag is held in the internal buffer and
   * emitted on the next call (or on flush).
   */
  feed(chunk: string): string {
    if (!chunk) {
      return "";
    }
    this.buf += chunk;
    let emitted = "";
    while (this.buf.length > 0) {
      if (this.inSpan) {
        const closeIdx = this.indexOf(this.buf, this.closeTagCompare);
        if (closeIdx === -1) {
          // Hold back as much as could still complete the close tag.
          const keepFrom = partialPrefixSuffixStart(
            this.caseInsensitive ? this.buf.toLowerCase() : this.buf,
            this.closeTagCompare,
          );
          // We discard everything before the held suffix — it's inside
          // the span — and keep the suffix in `buf` for the next feed.
          this.buf = this.buf.slice(keepFrom);
          break;
        }
        // Drop everything through closeTag; recurse on the remainder.
        this.buf = this.buf.slice(closeIdx + this.closeTag.length);
        this.inSpan = false;
        // Loop to process remainder in state A.
      } else {
        const openIdx = this.indexOf(this.buf, this.openTagCompare);
        if (openIdx === -1) {
          // Emit everything up to the longest partial-suffix of openTag.
          const keepFrom = partialPrefixSuffixStart(
            this.caseInsensitive ? this.buf.toLowerCase() : this.buf,
            this.openTagCompare,
          );
          emitted += this.buf.slice(0, keepFrom);
          this.buf = this.buf.slice(keepFrom);
          break;
        }
        // Emit text before openTag, drop the tag, transition to inSpan.
        emitted += this.buf.slice(0, openIdx);
        this.buf = this.buf.slice(openIdx + this.openTag.length);
        this.inSpan = true;
      }
    }
    return emitted;
  }

  /**
   * Signal end-of-stream. Returns any final emit. If we're mid-span at
   * EOS we DISCARD the held buffer — leaking a partial memory-context
   * is worse than a truncated answer.
   */
  flush(): string {
    if (this.inSpan) {
      this.buf = "";
      return "";
    }
    const out = this.buf;
    this.buf = "";
    return out;
  }

  /** Reset the scrubber for reuse across independent streams. */
  reset(): void {
    this.buf = "";
    this.inSpan = false;
  }
}

/**
 * One-shot, non-streaming variant. Strips all complete spans and any
 * trailing unclosed span. Use for non-streaming responses or as a final
 * defence-in-depth pass when the streaming path is bypassed.
 */
export function scrubContextOnce(input: string, options: ScrubberOptions): string {
  const scrubber = new StreamingContextScrubber(options);
  const head = scrubber.feed(input);
  const tail = scrubber.flush();
  return head + tail;
}

/**
 * Default tag set for Bitterbot memory injections. Not used by default
 * today (memory blocks are plain markdown), but available for the
 * optional fence-injection experiment (see PLAN-15 Phase 3 docs).
 */
export const DEFAULT_MEMORY_FENCE: ScrubberOptions = {
  openTag: "<memory-context>",
  closeTag: "</memory-context>",
  caseInsensitive: true,
};
