/**
 * Deprecated config keys in `bitterbot doctor` (PLAN-56 drift pass). The
 * loader already warns about them (DEPRECATED_PATHS); doctor names each key
 * as a finding and `doctor --fix` (or accepting the repair prompt) removes
 * the ones that are inert (every key in DEPRECATED_PATHS is inert).
 */

import type { BitterbotConfig } from "../config/config.js";
import { INCLUDE_KEY } from "../config/includes.js";

export type DeprecatedConfigHit = { path: string; value: unknown; reason: string };

type PathToken = string | number;

/** `agents.list[1].runtime.engine` -> ["agents", "list", 1, "runtime", "engine"]. */
export function parseConfigPath(dotted: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const part of dotted.split(".")) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      tokens.push(part);
      continue;
    }
    tokens.push(match[1]);
    for (const idx of match[2].matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(idx[1]));
    }
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Delete the value at `tokens` in place. A parent object left empty by the
 * delete goes too (`runtime: {}` after removing `runtime.engine`), one level
 * only, never an array element.
 */
function deleteAtPath(root: unknown, tokens: PathToken[]): boolean {
  const parents: unknown[] = [];
  let node: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    parents.push(node);
    if (typeof token === "number") {
      node = Array.isArray(node) ? node[token] : undefined;
    } else {
      node = isRecord(node) ? node[token] : undefined;
    }
    if (node === undefined) {
      return false;
    }
  }
  const last = tokens[tokens.length - 1];
  if (typeof last !== "string" || !isRecord(node) || !(last in node)) {
    return false;
  }
  delete node[last];
  const parentKey = tokens[tokens.length - 2];
  const grandparent = parents[parents.length - 1];
  if (
    Object.keys(node).length === 0 &&
    typeof parentKey === "string" &&
    isRecord(grandparent) &&
    grandparent[parentKey] === node
  ) {
    delete grandparent[parentKey];
  }
  return true;
}

/**
 * Remove the inert deprecated keys `hits` names from a copy of `config`.
 * Returns the new config and one line per change. `applied` says whether the
 * caller will write the result (`doctor --fix`): a preview run says "Would
 * remove", never "Removed", since nothing was written.
 */
export function removeDeprecatedConfigKeys(
  config: BitterbotConfig,
  hits: DeprecatedConfigHit[],
  opts: { applied?: boolean } = {},
): { config: BitterbotConfig; changes: string[] } {
  const next = structuredClone(config);
  const changes: string[] = [];
  const verb = opts.applied ? "Removed" : "Would remove";
  for (const hit of hits) {
    if (deleteAtPath(next, parseConfigPath(hit.path))) {
      changes.push(`- ${verb} ${hit.path} (deprecated, no effect).`);
    }
  }
  return { config: next, changes };
}

/** True when `$include` appears anywhere in the parsed root file. */
export function configUsesInclude(parsed: unknown): boolean {
  if (Array.isArray(parsed)) {
    return parsed.some((item) => configUsesInclude(item));
  }
  if (!isRecord(parsed)) {
    return false;
  }
  if (INCLUDE_KEY in parsed) {
    return true;
  }
  return Object.values(parsed).some((value) => configUsesInclude(value));
}

/**
 * Which file a key lives in, as far as the root file tells: the `$include`
 * value met on the way down (relative to the root config), or null for the
 * root file itself.
 */
export function locateConfigKey(parsed: unknown, dottedPath: string): string | null {
  let node: unknown = parsed;
  for (const token of parseConfigPath(dottedPath)) {
    if (isRecord(node) && INCLUDE_KEY in node) {
      const include = node[INCLUDE_KEY];
      return Array.isArray(include) ? include.map(String).join(", ") : String(include);
    }
    if (typeof token === "number") {
      node = Array.isArray(node) ? node[token] : undefined;
    } else {
      node = isRecord(node) ? node[token] : undefined;
    }
    if (node === undefined) {
      return null;
    }
  }
  return null;
}

/**
 * True when JSON5 text carries a `//` or `/* *\/` comment outside a string.
 * A config write re-serialises the file and loses comments.
 */
export function json5HasComments(raw: string | null | undefined): boolean {
  if (!raw) {
    return false;
  }
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) {
      return true;
    }
  }
  return false;
}
