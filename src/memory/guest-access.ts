/**
 * What a non-owner may see of the owner's memory (PLAN-53 G2).
 *
 * In a group chat or a DM from someone else, the agent still answers, but its
 * recall must not hand the owner's personal life to that person. Guests see
 * only memories explicitly tagged `normal` whose text also tags `normal`
 * today; untagged rows (dream insights, extracted facts, scratch notes) and
 * session transcripts stay with the owner.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemorySearchResult } from "./types.js";

export type Sensitivity = "normal" | "personal" | "confidential";

const RANK: Record<Sensitivity, number> = { normal: 0, personal: 1, confidential: 2 };

/** Content-based sensitivity. Conservative: a false "personal" only hides a memory from guests. */
export function tagSensitivity(text: string): Sensitivity {
  if (
    /\b(?:password|passphrase|secret|api[_\s-]?key|token|bearer|credential|private[_\s-]?key|ssh[_\s-]?key|seed phrase|recovery phrase)\b/i.test(
      text,
    )
  ) {
    return "confidential";
  }
  if (
    /\b(?:my name|my email|my phone|my address|home address|birthday|date of birth|social security|ssn|credit card|bank account|diagnos(?:is|ed)|medication|therapist|salary)\b/i.test(
      text,
    )
  ) {
    return "personal";
  }
  if (/\b(?:i feel|i think|personally|my opinion|my preference)\b/i.test(text)) {
    return "personal";
  }
  return "normal";
}

/** The more restrictive of two tags. */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[a] >= RANK[b] ? a : b;
}

type Row = { governance_json: string | null; text: string; source: string };

function rowIsGuestVisible(row: Row): boolean {
  if (row.source === "sessions") {
    return false;
  }
  let tagged: unknown;
  try {
    tagged = row.governance_json
      ? (JSON.parse(row.governance_json) as { sensitivity?: unknown }).sensitivity
      : undefined;
  } catch {
    return false;
  }
  return tagged === "normal" && tagSensitivity(row.text) === "normal";
}

const WORKING_MEMORY = /^(?:memory\.md|MEMORY\.md)$/;

/** Search hits a guest may see. A hit with no stored row is dropped. */
export function filterGuestResults(
  db: DatabaseSync,
  results: MemorySearchResult[],
): MemorySearchResult[] {
  const stmt = db.prepare(
    "SELECT governance_json, text, source FROM chunks WHERE path = ? AND start_line = ? AND end_line = ?",
  );
  return results.filter((r) => {
    if (r.source === "sessions" || WORKING_MEMORY.test(r.path)) {
      return false;
    }
    const rows = stmt.all(r.path, r.startLine, r.endLine) as unknown as Row[];
    return rows.length > 0 && rows.every(rowIsGuestVisible);
  });
}

/** Whether a guest may read a memory file directly (memory_get). */
export function guestMayReadPath(db: DatabaseSync, relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (WORKING_MEMORY.test(normalized)) {
    return false;
  }
  const rows = db
    .prepare("SELECT governance_json, text, source FROM chunks WHERE path = ?")
    .all(normalized) as unknown as Row[];
  return rows.length > 0 && rows.every(rowIsGuestVisible);
}
