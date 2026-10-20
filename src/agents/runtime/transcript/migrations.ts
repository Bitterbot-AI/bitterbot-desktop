/**
 * PLAN-52 Phase 1: transcript migrations v1 -> v2 -> v3.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono). Entries
 * are mutated in place, exactly as upstream does, so a migrated file is
 * rewritten with the same key order upstream produces (new keys appended).
 *
 * - v1 -> v2: every non-header entry gets an 8-hex id and a linear parentId
 *   chain; a compaction's numeric `firstKeptEntryIndex` becomes
 *   `firstKeptEntryId`.
 * - v2 -> v3: message role `hookMessage` becomes `custom`.
 *
 * A file at version 3 or higher is left alone (a future version included).
 */

import { randomUUID } from "node:crypto";
import { TRANSCRIPT_VERSION } from "./types.js";

type Loose = Record<string, unknown>;

/** 8 lowercase hex chars, unique within `existing` (falls back to a full UUID). */
export function generateEntryId(existing: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function migrateV1ToV2(entries: Loose[]): void {
  // Upstream never adds to this set, so there is no real collision check
  // during migration; kept identical on purpose (ids are 32 bits of entropy
  // over a file of a few hundred entries).
  const ids = new Set<string>();
  let prevId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }
    entry.id = generateEntryId(ids);
    entry.parentId = prevId;
    prevId = entry.id as string;
    if (entry.type === "compaction") {
      if (typeof entry.firstKeptEntryIndex === "number") {
        const target = entries[entry.firstKeptEntryIndex];
        if (target && target.type !== "session") {
          entry.firstKeptEntryId = target.id;
        }
        delete entry.firstKeptEntryIndex;
      }
    }
  }
}

function migrateV2ToV3(entries: Loose[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (entry.type === "message") {
      const message = entry.message as Loose | undefined;
      if (message && message.role === "hookMessage") {
        message.role = "custom";
      }
    }
  }
}

/** Migrate in place. Returns true when anything changed (the caller rewrites the file). */
export function migrateToCurrentVersion(entries: Loose[]): boolean {
  const header = entries.find((e) => e.type === "session");
  const version = typeof header?.version === "number" ? header.version : 1;
  if (version >= TRANSCRIPT_VERSION) {
    return false;
  }
  if (version < 2) {
    migrateV1ToV2(entries);
  }
  if (version < 3) {
    migrateV2ToV3(entries);
  }
  return true;
}
