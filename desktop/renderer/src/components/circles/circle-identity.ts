// PLAN-36 Phase B (circle identity): every circle gets a stable visual
// identity derived from its circleId — a hue-rotated gradient — plus an
// optional glyph: a name that STARTS with an emoji shows that emoji on the
// tile instead of initials ("Tahoe 🏔️" shows initials; "🏔️ Tahoe" shows 🏔️).
// Pure module, no React — the rail, the chat header, and anything else that
// names a circle render the same identity from here.

export interface CircleIdentity {
  /** The leading emoji of the name, if the name starts with one. */
  emoji: string | null;
  /** Up-to-two-letter fallback when there is no leading emoji. */
  initials: string;
  /** CSS background for the tile/chip. */
  gradient: string;
  /** A single accent color (dots, rings) from the same hue. */
  accent: string;
}

/** Stable 32-bit hash → hue bucket. Same circleId → same color, forever. */
export function hueFor(circleId: string): number {
  let h = 0;
  for (let i = 0; i < circleId.length; i += 1) h = (h * 31 + circleId.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * The first grapheme of the name when it is an emoji, else null. Uses
 * Intl.Segmenter so multi-codepoint emoji (flags, ZWJ families, skin tones)
 * come back whole; falls back to a pictographic regex probe.
 */
export function leadingEmoji(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  let first = trimmed;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const it = seg.segment(trimmed)[Symbol.iterator]().next();
    if (!it.done) first = it.value.segment;
  } else {
    first = String.fromCodePoint(trimmed.codePointAt(0) as number);
  }
  return /\p{Extended_Pictographic}/u.test(first) ? first : null;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] + (parts[1] as string)[0]).toUpperCase();
}

export function circleIdentity(circleId: string, name: string): CircleIdentity {
  const h = hueFor(circleId);
  const emoji = leadingEmoji(name);
  return {
    emoji,
    // Initials skip a leading emoji — "🏔️ Tahoe" falls back to "TA", not "🏔T".
    initials: initialsFor(emoji ? name.trim().slice(emoji.length) : name),
    // Mid-lightness so the white glyph reads on both themes.
    gradient: `linear-gradient(135deg, hsl(${h} 62% 46%), hsl(${(h + 45) % 360} 58% 38%))`,
    accent: `hsl(${h} 62% 46%)`,
  };
}
