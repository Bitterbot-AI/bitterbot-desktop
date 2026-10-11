/**
 * PLAN-55 Phase 2 (G4), consumer 3: learned preferences follow the ledger.
 *
 * A `user_preferences` row maps to a canonical key as `<category>.<key>`
 * (the same mapping seedFromIdentityPreferences uses to seed the ledger),
 * compared after normalisation with `.`, `_` and `-` treated alike, so
 * `identity/user_name` matches `identity.user.name`. When the ledger value
 * changes, the matching row is updated to the new value; when the owner
 * retires the fact, a row still holding the retired value is removed. Rows
 * are never created here, and a new value the owner has suppressed as a
 * preference (key or value) removes the row instead of writing it back.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import {
  isSuppressed,
  normalizeExact,
  preferenceKeyHash,
  preferenceValueHash,
} from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

const keyShape = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "_");

/** Does preference (category, key) address canonical key `factKey`? */
export function preferenceMatchesCanonicalKey(
  category: string,
  key: string,
  factKey: string,
): boolean {
  return keyShape(`${category}.${key}`) === keyShape(factKey);
}

export type PreferencePropagationResult = { updated: number; removed: number };

export function propagateToPreferences(
  db: DatabaseSync,
  event: CanonicalChangeEvent,
): PreferencePropagationResult {
  const result: PreferencePropagationResult = { updated: 0, removed: 0 };
  const dot = event.key.indexOf(".");
  if (dot <= 0) {
    return result;
  }
  // Candidates by category (the key's first segment); the table is small
  // and the category index bounds the read.
  const category = event.key.slice(0, dot);
  let rows: Array<{ id: string; category: string; key: string; value: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, category, key, value FROM user_preferences WHERE lower(category) = ? LIMIT 500`,
      )
      .all(category.toLowerCase()) as unknown as typeof rows;
  } catch {
    return result; // no user model on this database
  }
  const matches = rows.filter((r) => preferenceMatchesCanonicalKey(r.category, r.key, event.key));
  if (matches.length === 0) {
    return result;
  }
  const remove = db.prepare(`DELETE FROM user_preferences WHERE id = ?`);
  const update = db.prepare(`UPDATE user_preferences SET value = ?, updated_at = ? WHERE id = ?`);
  for (const row of matches) {
    if (event.op === "retire") {
      // Only the owner's retire says the value is wrong; only a row that
      // still holds that value goes.
      if (
        event.retireReason === "owner" &&
        event.oldValue &&
        normalizeExact(row.value) === normalizeExact(event.oldValue)
      ) {
        result.removed += Number(remove.run(row.id).changes);
      }
      continue;
    }
    if (!event.newValue || normalizeExact(row.value) === normalizeExact(event.newValue)) {
      continue;
    }
    // A value can only be written over the row by a writer at least as
    // trusted as the extraction lane that learned it.
    if (event.tier < 1) {
      continue;
    }
    const suppressed =
      isSuppressed(db, "preference_key", preferenceKeyHash(row.category, row.key)) ??
      isSuppressed(db, "preference_value", preferenceValueHash(row.category, event.newValue));
    if (suppressed) {
      result.removed += Number(remove.run(row.id).changes);
      continue;
    }
    result.updated += Number(update.run(event.newValue, event.at, row.id).changes);
  }
  if (result.updated + result.removed > 0) {
    log.info(
      `canonical:changed [${event.key}] preferences: ${result.updated} updated, ${result.removed} removed`,
    );
  }
  return result;
}
