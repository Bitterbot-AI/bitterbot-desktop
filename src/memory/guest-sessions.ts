/**
 * Sessions where someone other than the owner talked to the agent.
 *
 * A group chat is recognisable from its session key, but a direct chat with
 * an approved contact is not: it looks like the owner's own. Without this
 * record, what a contact said ("I'm vegetarian") could become a standing
 * preference or a canonical fact about the owner. The run marks the session
 * on each guest turn; session trust then treats it as third-party.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const MAX_SESSIONS = 5000;

function registryFile(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "memory", "guest-sessions.json");
}

let cache: { file: string; mtimeMs: number; keys: Set<string> } | null = null;

function load(file: string): Set<string> {
  try {
    const stat = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) {
      return cache.keys;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const keys = new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : []);
    cache = { file, mtimeMs: stat.mtimeMs, keys };
    return keys;
  } catch {
    return new Set();
  }
}

export function isGuestSession(sessionKey: string, stateDir?: string): boolean {
  return load(registryFile(stateDir)).has(sessionKey.toLowerCase());
}

export function markGuestSession(sessionKey: string, stateDir?: string): void {
  const file = registryFile(stateDir);
  const key = sessionKey.toLowerCase();
  const keys = load(file);
  if (keys.has(key)) {
    return;
  }
  const next = [...keys, key].slice(-MAX_SESSIONS);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = null;
  } catch {
    // Best effort: a failed mark only means this turn's transcript keeps the
    // trust its session key gives it.
  }
}

export function resetGuestSessionsCacheForTest(): void {
  cache = null;
}
