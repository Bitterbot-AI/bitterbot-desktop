/**
 * PLAN-52 Phase 5: gitignore-style path matcher used by the skill loader.
 *
 * pi-coding-agent 0.73.1 filters skill discovery through the `ignore` npm
 * package (7.0.5, MIT, Copyright (c) 2013 Kael Zhang and contributors). This
 * repo does not depend on `ignore` directly, so the part pi's skill loader
 * reaches is ported here: `ignore()`, `.add(string[])` and `.ignores(path)`
 * with default options (case-insensitive, strict path check).
 *
 * Ported from `ignore` 7.0.5 `index.js`. The pattern-to-regex replacer table
 * is copied rule for rule, in the same order, with the same regular
 * expressions; it decides which skills are discovered, so it must not drift.
 *
 * Differences from the original:
 *
 * 1. Typing. The replacers get the original pattern as an argument where the
 *    original binds it as `this`.
 * 2. Only the surface the skill loader uses is ported. Left out: options
 *    (`ignorecase`, `allowRelativePaths`), `add()` with a single string or
 *    another `Ignore` instance, `test()`, `checkIgnore()`, `filter()`,
 *    `createFilter()`, `isPathValid()` and the `checkRegex` mode.
 * 3. `ignores()` takes a string, so the "path must be a string" error of the
 *    original cannot happen and is not ported. The empty-path and
 *    not-relative-path errors are kept.
 * 4. The result cache is a `Map` where the original uses a null-prototype
 *    object. Same keys, same reset on every `add()` that adds a rule.
 * 5. Two anchored tests inside the code (not matchers of the replacer table)
 *    use string methods where the original uses a regular expression: "ends
 *    with a slash" in the ending step and the `\\?\` prefix test on Windows.
 *    Same results.
 *
 * Kept as in the original, on purpose:
 * - A rule's regular expression is compiled on first use, not in `add()`. A
 *   pattern that produces an invalid regular expression therefore throws from
 *   `ignores()`, every time that rule is reached, and never from `add()`.
 * - A path inside an ignored directory stays ignored; a later negated pattern
 *   cannot bring it back.
 * - Blank lines, lines starting with `#` and lines ending in a single
 *   backslash are dropped by `add()`.
 * - On Windows backslashes in the tested path are converted to `/` (unless the
 *   path starts with `\\?\` or holds one of `"<>|` or a control character) and
 *   a drive-letter path counts as not relative.
 */

const REGEX_TEST_BLANK_LINE = /^\s+$/;
const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
const REGEX_REPLACE_LEADING_ESCAPED_EXCLAMATION = /^\\!/;
const REGEX_REPLACE_LEADING_ESCAPED_HASH = /^\\#/;

// Invalid: `/foo`, `./foo`, `../foo`, `.`, `..`. Valid: `.foo`.
const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;

/** Drops out-of-order ranges, which gitignore accepts and a JS RegExp rejects. */
function sanitizeRange(range: string): string {
  return range.replace(REGEX_REGEXP_RANGE, (match: string, from: string, to: string) =>
    from.charCodeAt(0) <= to.charCodeAt(0) ? match : "",
  );
}

function cleanRangeBackSlash(slashes: string): string {
  const { length } = slashes;
  return slashes.slice(0, length - (length % 2));
}

/**
 * One step of the pattern-to-regex conversion. `pattern` is the rule body
 * before any step ran; `args` is what `String.prototype.replace` passes to a
 * replacer function (match, capture groups, offset, whole string).
 */
type Replacer = readonly [matcher: RegExp, replace: (pattern: string, args: unknown[]) => string];

function str(value: unknown): string {
  return value as string;
}

const REPLACERS: readonly Replacer[] = [
  // Remove BOM.
  [/^﻿/, () => ""],

  // Trailing spaces are ignored unless they are quoted with a backslash.
  // (a\ ) -> (a ), (a  ) -> (a), (a ) -> (a), (a \ ) -> (a  )
  [
    /((?:\\\\)*?)(\\?\s+)$/,
    (_pattern, [, m1, m2]) => str(m1) + (str(m2).indexOf("\\") === 0 ? " " : ""),
  ],

  // Replace (\ ) with ' '. (\ ) -> ' ', (\\ ) -> '\\ ', (\\\ ) -> '\\ '
  [
    /(\\+?)\s/g,
    (_pattern, [, m1]) => {
      const { length } = str(m1);
      return `${str(m1).slice(0, length - (length % 2))} `;
    },
  ],

  // Escape the characters that are literal in gitignore and special in a RegExp.
  [/[\\$.|*+(){^]/g, (_pattern, [match]) => `\\${str(match)}`],

  // A question mark matches a single character.
  [/(?!\\)\?/g, () => "[^/]"],

  // A leading slash matches the beginning of the pathname.
  [/^\//, () => "^"],

  // Escape the remaining slashes.
  [/\//g, () => "\\/"],

  // A leading "**" followed by a slash means match in all directories.
  // The '*'s were escaped to '\\*' above.
  [/^\^*\\\*\\\*\\\//, () => "^(?:.*\\/)?"],

  // Starting. A pattern with a slash at the beginning or in the middle is
  // relative to the ignore file's directory; otherwise it matches at any level.
  [/^(?=[^^])/, (pattern) => (!/\/(?!$)/.test(pattern) ? "(?:^|\\/)" : "^")],

  // Two globstars. `/**/` matches zero or more directories; a trailing `/**`
  // matches everything inside (but not the directory itself).
  [
    /\\\/\\\*\\\*(?=\\\/|$)/g,
    (_pattern, [, index, whole]) =>
      (index as number) + 6 < str(whole).length ? "(?:\\/[^\\/]+)*" : "\\/.+",
  ],

  // Normal intermediate wildcards. An asterisk matches anything except a
  // slash. A trailing single wildcard is handled when the rule is compiled.
  [
    /(^|[^\\]+)(\\\*)+(?=.+)/g,
    (_pattern, [, p1, p2]) => str(p1) + str(p2).replace(/\\\*/g, "[^\\/]*"),
  ],

  // Unescape, reverting the metacharacter step except for the backslash.
  [/\\\\\\(?=[$.|*+(){^])/g, () => "\\"],

  // '\\\\' -> '\\'
  [/\\\\/g, () => "\\"],

  // Range notation, for example [a-zA-Z].
  [
    /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
    (_pattern, [, leadEscape, range, endEscape, close]) =>
      leadEscape === "\\"
        ? `\\[${str(range)}${cleanRangeBackSlash(str(endEscape))}${str(close)}`
        : close === "]"
          ? str(endEscape).length % 2 === 0
            ? `[${sanitizeRange(str(range))}${str(endEscape)}]`
            : "[]"
          : "[]",
  ],

  // Ending. 'js' does not match 'js.' or 'jsx'; 'foo/' matches only the
  // directory form; 'foo' matches both 'foo' and 'foo/'.
  [
    /(?:[^*])$/,
    (_pattern, [match]) =>
      str(match).endsWith("/") ? `${str(match)}$` : `${str(match)}(?=$|\\/$)`,
  ],
];

const REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;

function replaceTrailingWildcard(_match: string, p1: string | undefined): string {
  // '/*' does not match the empty string and 'abc/*' does not match 'abc/';
  // 'a*' matches 'a' and 'aa'.
  const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
  return `${prefix}(?=$|\\/$)`;
}

function makeRegexPrefix(pattern: string): string {
  return REPLACERS.reduce(
    (prev, [matcher, replace]) =>
      prev.replace(matcher, (...args: unknown[]) => replace(pattern, args)),
    pattern,
  );
}

function checkPattern(pattern: string): boolean {
  return (
    Boolean(pattern) &&
    !REGEX_TEST_BLANK_LINE.test(pattern) &&
    !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) &&
    // A line starting with # is a comment.
    pattern.indexOf("#") !== 0
  );
}

class IgnoreRule {
  readonly negative: boolean;
  private readonly regexPrefix: string;
  private compiled: RegExp | undefined;

  constructor(pattern: string) {
    let negative = false;
    let body = pattern;

    // An optional prefix "!" negates the pattern.
    if (body.indexOf("!") === 0) {
      negative = true;
      body = body.slice(1);
    }

    // A leading backslash keeps a literal "!" or "#" at the start.
    body = body
      .replace(REGEX_REPLACE_LEADING_ESCAPED_EXCLAMATION, "!")
      .replace(REGEX_REPLACE_LEADING_ESCAPED_HASH, "#");

    this.negative = negative;
    this.regexPrefix = makeRegexPrefix(body);
  }

  /** Compiled on first use; an invalid expression throws here on every call. */
  get regex(): RegExp {
    if (this.compiled) {
      return this.compiled;
    }
    const source = this.regexPrefix.replace(
      REGEX_REPLACE_TRAILING_WILDCARD,
      replaceTrailingWildcard,
    );
    this.compiled = new RegExp(source, "i");
    return this.compiled;
  }
}

type TestResult = { ignored: boolean; unignored: boolean };

const isWindows = typeof process !== "undefined" && process.platform === "win32";

function isNotRelativePosix(path: string): boolean {
  return REGEX_TEST_INVALID_PATH.test(path);
}

function convertPath(path: string): string {
  if (!isWindows) {
    return path;
  }
  // oxlint-disable-next-line no-control-regex -- copied from `ignore`
  return path.startsWith("\\\\?\\") || /["<>|\u0000-\u001F]+/u.test(path)
    ? path
    : path.replace(/\\/g, "/");
}

function isNotRelative(path: string): boolean {
  if (isWindows && /^[a-z]:\//i.test(path)) {
    return true;
  }
  return isNotRelativePosix(path);
}

export class SkillIgnoreMatcher {
  private rules: IgnoreRule[] = [];
  private cache = new Map<string, TestResult>();

  /** Adds gitignore patterns, one per array element. */
  add(patterns: readonly string[]): this {
    let added = false;
    for (const pattern of patterns) {
      if (checkPattern(pattern)) {
        this.rules.push(new IgnoreRule(pattern));
        added = true;
      }
    }
    if (added) {
      // The rules changed, so cached results are stale.
      this.cache = new Map();
    }
    return this;
  }

  /**
   * Whether `path` (relative, `/`-separated, directories with a trailing `/`)
   * is ignored. Throws a TypeError on an empty path and a RangeError on a path
   * that is not relative (`/a`, `./a`, `../a`, `.`, `..`).
   */
  ignores(originalPath: string): boolean {
    const path = originalPath && convertPath(originalPath);
    if (!path) {
      throw new TypeError("path must not be empty");
    }
    if (isNotRelative(path)) {
      throw new RangeError(
        `path should be a \`path.relative()\`d string, but got "${originalPath}"`,
      );
    }
    return this.testWithParents(path).ignored;
  }

  /** Tests the parent directories first, outermost first, then the path. */
  private testWithParents(path: string, slices?: string[]): TestResult {
    const cached = this.cache.get(path);
    if (cached) {
      return cached;
    }

    // path/to/a.js -> ['path', 'to', 'a.js']
    const parts = slices ?? path.split("/").filter(Boolean);
    parts.pop();

    let result: TestResult;
    if (parts.length === 0) {
      // No parent directory: test the path itself.
      result = this.testRules(path);
    } else {
      const parent = this.testWithParents(`${parts.join("/")}/`, parts);
      // A file cannot be re-included when a parent directory is excluded.
      result = parent.ignored ? parent : this.testRules(path);
    }
    this.cache.set(path, result);
    return result;
  }

  /** Tests one path against the rules without looking at parent directories. */
  private testRules(path: string): TestResult {
    let ignored = false;
    let unignored = false;

    for (const rule of this.rules) {
      const { negative } = rule;
      // Skip a rule that cannot change the outcome: a negated rule while
      // nothing is ignored, or a plain rule while the path is already ignored.
      if (
        (unignored === negative && ignored !== unignored) ||
        (negative && !ignored && !unignored)
      ) {
        continue;
      }
      if (!rule.regex.test(path)) {
        continue;
      }
      ignored = !negative;
      unignored = negative;
    }

    return { ignored, unignored };
  }
}

/** Same as `ignore()` from the `ignore` package with default options. */
export function createSkillIgnoreMatcher(): SkillIgnoreMatcher {
  return new SkillIgnoreMatcher();
}
