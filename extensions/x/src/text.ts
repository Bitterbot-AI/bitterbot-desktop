/**
 * Text helpers for X posts: weighted length (X counts most Latin-range code
 * points as 1 and everything else as 2; every URL counts as 23), link and
 * mention detection, and a normalized form for duplicate detection.
 */

export const X_MAX_WEIGHTED_LENGTH = 280;
const URL_WEIGHT = 23;

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const BARE_DOMAIN_RE =
  /(^|[\s(])((?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|dev|app|xyz|me|gg|so|sh|tv|info|edu|gov|us|uk|de|fr|ca|au|nl|eu|ly|to|link|news|blog|social|cloud|tech|wtf|lol))(?=$|[\s)/.,!?:;])/gi;
const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

function codePointWeight(cp: number): number {
  if (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  ) {
    return 1;
  }
  return 2;
}

/** Weighted length as X counts it (approximation of twitter-text v3). */
export function weightedLength(text: string): number {
  const normalized = text.normalize("NFC");
  let total = 0;
  let cursor = 0;
  const matches = [...normalized.matchAll(URL_RE)];
  for (const match of matches) {
    const start = match.index ?? 0;
    total += weightSegment(normalized.slice(cursor, start));
    total += URL_WEIGHT;
    cursor = start + match[0].length;
  }
  total += weightSegment(normalized.slice(cursor));
  return total;
}

function weightSegment(segment: string): number {
  let sum = 0;
  for (const ch of segment) {
    sum += codePointWeight(ch.codePointAt(0) ?? 0);
  }
  return sum;
}

export function findLinks(text: string): string[] {
  const links = [...text.matchAll(URL_RE)].map((m) => m[0]);
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    links.push(m[2]);
  }
  return links;
}

/** Mentioned handles, lowercased, without the @. */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    out.push(m[2].toLowerCase());
  }
  return out;
}

/** Lowercase, strip punctuation/urls, collapse whitespace. */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordTrigrams(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  const grams = new Set<string>();
  if (words.length === 0) {
    return grams;
  }
  if (words.length < 3) {
    grams.add(words.join(" "));
    return grams;
  }
  for (let i = 0; i + 3 <= words.length; i += 1) {
    grams.add(words.slice(i, i + 3).join(" "));
  }
  return grams;
}

/** Jaccard similarity over word trigrams of the normalized texts; 1 = identical. */
export function similarity(a: string, b: string): number {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  if (!na || !nb) {
    return 0;
  }
  if (na === nb) {
    return 1;
  }
  const ga = wordTrigrams(na);
  const gb = wordTrigrams(nb);
  let inter = 0;
  for (const g of ga) {
    if (gb.has(g)) {
      inter += 1;
    }
  }
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}
