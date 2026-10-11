/**
 * Deprecated config keys in `bitterbot doctor` (PLAN-56 drift pass). The
 * loader already warns about them (DEPRECATED_PATHS); doctor names each key
 * as a finding and `doctor --fix` (or accepting the repair prompt) removes
 * the ones that are inert. `memory.curiosity.autoResearch.enabled` is the
 * exception: `false` moves to `memory.curiosity.research.enabled` (same
 * effect), and `true` stays because the dream engine's Skill Seekers
 * research step still reads it (src/memory/dream-engine.ts).
 */

import type { BitterbotConfig } from "../config/config.js";

export type DeprecatedConfigHit = { path: string; value: unknown; reason: string };

const AUTO_RESEARCH_ENABLED = "memory.curiosity.autoResearch.enabled";

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
 * Returns the new config, one line per change, and the keys left in place
 * with the reason.
 */
export function removeDeprecatedConfigKeys(
  config: BitterbotConfig,
  hits: DeprecatedConfigHit[],
): { config: BitterbotConfig; changes: string[]; kept: string[] } {
  const next = structuredClone(config);
  const changes: string[] = [];
  const kept: string[] = [];
  for (const hit of hits) {
    if (hit.path === AUTO_RESEARCH_ENABLED) {
      if (hit.value !== false) {
        kept.push(
          `- ${hit.path}: left in place; \`true\` still switches on the dream engine's Skill Seekers research step.`,
        );
        continue;
      }
      const curiosity = next.memory?.curiosity as unknown as
        | { research?: { enabled?: boolean } & Record<string, unknown> }
        | undefined;
      if (curiosity && curiosity.research?.enabled === undefined) {
        curiosity.research = { ...curiosity.research, enabled: false };
        changes.push(`- Moved ${hit.path}=false to memory.curiosity.research.enabled=false.`);
      } else {
        changes.push(
          `- Removed ${hit.path} (memory.curiosity.research.enabled is set and takes precedence).`,
        );
      }
      deleteAtPath(next, parseConfigPath(hit.path));
      continue;
    }
    if (deleteAtPath(next, parseConfigPath(hit.path))) {
      changes.push(`- Removed ${hit.path} (deprecated, no effect).`);
    }
  }
  return { config: next, changes, kept };
}
