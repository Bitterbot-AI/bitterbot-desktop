/**
 * Canonical-facts hygiene (token-efficiency build, 2026-09-19).
 *
 * The heartbeat prompt ("Read HEARTBEAT.md if it exists ... reply
 * HEARTBEAT_OK") ran ~48 times a day in the main session for two months and
 * the extraction lane dutifully "learned" it: 22 of 50 active canonical facts
 * on the live node were heartbeat scaffolding (`project.heartbeat_file =
 * HEARTBEAT.md`, 30 mentions; `preference.heartbeat_reply = HEARTBEAT_OK`;
 * ...). Every one of them rendered into every system prompt.
 *
 * Two guards: `isHeartbeatArtifact` rejects such facts at ingest, and
 * `sweepHeartbeatArtifacts` retires the ones already stored. Both are pure
 * pattern checks on key + value; nothing about a real user preference
 * mentions the heartbeat protocol text.
 */
import type { DatabaseSync } from "node:sqlite";

const KEY_RX =
  /(^|[._-])heartbeat([._-]|$)|heartbeat_?(ok|md|file|reply|response|protocol|prompt)/i;
const VALUE_RX =
  /^\s*(HEARTBEAT_OK|HEARTBEAT\.md|read HEARTBEAT\.md|heartbeat checks? via HEARTBEAT\.md)\s*\.?\s*$/i;
const PROMPT_RX =
  /read heartbeat\.md if it exists|follow it strictly|do not infer or repeat old tasks|if nothing needs attention,? reply heartbeat_ok/i;
// Time-line junk the same lane produces from the "Current time:" suffix.
const CLOCK_KEY_RX = /^(project|session|context)\.(date|time|datetime|current_time)$/i;

const ANY_HEARTBEAT_TEXT_RX = /heartbeat_ok|heartbeat\.md/i;
const PLACEHOLDER_VALUE_RX = /^(not stated|not specified|unknown|none|n\/a|unspecified|tbd)\.?$/i;

export function isHeartbeatArtifact(key: string, value: string): boolean {
  const k = key.trim();
  const v = value.trim();
  if (ANY_HEARTBEAT_TEXT_RX.test(v) || PLACEHOLDER_VALUE_RX.test(v)) {
    return true;
  }
  if (KEY_RX.test(k)) {
    return true;
  }
  if (VALUE_RX.test(v) || PROMPT_RX.test(v)) {
    return true;
  }
  if (CLOCK_KEY_RX.test(k)) {
    return true;
  }
  return false;
}

/**
 * Retire every active/superseded fact that matches `isHeartbeatArtifact`.
 * Idempotent; returns the number of rows changed. Safe to call before the
 * table exists (returns 0).
 */
export function sweepHeartbeatArtifacts(db: DatabaseSync): number {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_facts'`)
    .get();
  if (!exists) {
    return 0;
  }
  const rows = db
    .prepare(`SELECT id, key, value FROM canonical_facts WHERE status IN ('active', 'superseded')`)
    .all() as unknown as Array<{ id: string; key: string; value: string }>;
  const victims = rows.filter((r) => isHeartbeatArtifact(r.key, r.value));
  if (victims.length === 0) {
    return 0;
  }
  // Same semantics as CanonicalFactsStore.retire(): status only, so the row
  // stays visible to get()/history() and can be reactivated deliberately.
  const stmt = db.prepare(`UPDATE canonical_facts SET status = 'retired' WHERE id = ?`);
  for (const v of victims) {
    stmt.run(v.id);
  }
  return victims.length;
}
