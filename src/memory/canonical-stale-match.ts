/**
 * PLAN-55 Phase 2: the one matcher every canonical:changed consumer uses to
 * decide whether a piece of text still states a value the ledger replaced.
 *
 * Two conditions, both required:
 *
 * 1. **The old value as a whole identifier.** Letters, digits, `_` and `$`
 *    are word characters, and so are `.` and `-` when they join two word
 *    characters: "Max" does not match "max_tokens", "Math.max" or
 *    "Max-like", while "api.acme.com." at the end of a sentence still
 *    matches "api.acme.com". A value with a capital letter is matched
 *    case-sensitively ("Max" the dog is not "max" the setting); an
 *    all-lowercase value is matched case-insensitively. Values under three
 *    characters, numbers of up to four digits and generic words never match.
 * 2. **Key context.** The text also names what the key is about: a subject
 *    token of the key (its segments, minus a short stoplist of generic and
 *    category words, so `pet.dog.name` gives pet/dog/name and
 *    `user.home_city` gives home/city), as a whole word, plural allowed.
 *    The consumers that know the old fact's evidence (search) also accept a
 *    chunk from that evidence set without the subject token.
 *
 * A text that also states the new value describes the change and is never
 * treated as stale.
 */

import type { CanonicalChangeEvent } from "./canonical-events.js";

export const MIN_STALE_VALUE_CHARS = 3;
export const MAX_STALE_VALUE_CHARS = 200;

const GENERIC_VALUES = new Set([
  "yes",
  "no",
  "true",
  "false",
  "none",
  "null",
  "n/a",
  "unknown",
  "the",
  "and",
  "off",
  "on",
]);

/**
 * Key segments that say nothing about the subject: category prefixes and
 * filler. Deliberately small and synonym-free.
 */
const KEY_STOPLIST = new Set([
  "user",
  "users",
  "project",
  "projects",
  "identity",
  "infra",
  "preference",
  "preferences",
  "relationship",
  "relationships",
  "other",
  "the",
  "my",
  "of",
  "current",
  "default",
  "main",
  "primary",
  "value",
  "info",
]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WORD = "[\\p{L}\\p{N}_$]";
const BEFORE = `(?<!${WORD}|${WORD}[.\\-])`;
const AFTER = `(?!${WORD}|[.\\-]${WORD})`;

/** Whole-identifier matcher for a fact value, or null when the value is too weak to match on. */
export function staleValueMatcher(
  value: string | null | undefined,
): ((text: string) => boolean) | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  if (v.length < MIN_STALE_VALUE_CHARS || v.length > MAX_STALE_VALUE_CHARS) {
    return null;
  }
  if (GENERIC_VALUES.has(v.toLowerCase()) || /^\d{1,4}$/.test(v)) {
    return null;
  }
  if (!/[\p{L}\p{N}]/u.test(v)) {
    return null;
  }
  const body = v.split(" ").map(escapeRegExp).join("\\s+");
  const caseSensitive = /\p{Lu}/u.test(v);
  const rx = new RegExp(`${BEFORE}${body}${AFTER}`, caseSensitive ? "u" : "iu");
  return (text: string) => rx.test(text);
}

/** The key's subject tokens: segments split on `.`, `_`, `-`, minus the stoplist, 3+ chars. */
export function keySubjectTokens(key: string): string[] {
  const out = new Set<string>();
  for (const seg of key.toLowerCase().split(/[._-]+/)) {
    if (seg.length >= 3 && !KEY_STOPLIST.has(seg) && /\p{L}/u.test(seg)) {
      out.add(seg);
    }
  }
  return [...out];
}

/** Does the text name one of the key's subject tokens (whole word, plural allowed)? */
export function keyContextMatcher(key: string): ((text: string) => boolean) | null {
  const tokens = keySubjectTokens(key);
  if (tokens.length === 0) {
    return null;
  }
  const rx = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${tokens.map(escapeRegExp).join("|")})(?:s|es)?(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return (text: string) => rx.test(text);
}

export type StaleCitationMatcher = {
  /** States the old value (whole identifier) and not the new one. */
  statesOld: (text: string) => boolean;
  /** statesOld plus key context: the test briefs, tasks, insights and non-evidence chunks pass. */
  cites: (text: string) => boolean;
};

/** The matcher for one change, or null when the old value is too weak to match on. */
export function staleCitationMatcher(event: CanonicalChangeEvent): StaleCitationMatcher | null {
  const matchesOld = staleValueMatcher(event.oldValue);
  if (!matchesOld) {
    return null;
  }
  const matchesNew = staleValueMatcher(event.newValue);
  const context = keyContextMatcher(event.key);
  const statesOld = (text: string): boolean => matchesOld(text) && !matchesNew?.(text);
  return {
    statesOld,
    cites: (text: string) => statesOld(text) && Boolean(context?.(text)),
  };
}

/** FTS5 phrase query for a value: its letter/digit tokens in order. */
export function ftsPhraseForValue(value: string): string | null {
  const tokens = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  return `"${tokens.join(" ")}"`;
}

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Which project, if any, a change is limited to. `project:<name>` changes
 * touch only stores tied to that project's workspace; everything else is
 * global (person scopes render everywhere today, so they propagate
 * everywhere too).
 */
export function changeProject(event: CanonicalChangeEvent): string | null {
  return event.scope.startsWith("project:") ? event.scope.slice("project:".length) : null;
}
