/**
 * PLAN-55 Phase 2 (G4): the `canonical:changed` event.
 *
 * The ledger (CanonicalFactsStore) emits one of these after every write that
 * changes what the active value of a key is: a new key, a supersede, a
 * retire, an unretire, or a retired value coming back through a pin. The
 * memory manager forwards it on its event bus and hands it to the
 * propagation consumers (canonical-propagation.ts), which run off the write
 * path.
 *
 * Emission happens synchronously after the store's statements ran, which
 * may still be inside a caller's SAVEPOINT. Consumers therefore never act
 * on the payload alone: the dispatcher re-reads the fact row before it runs
 * anything (see isCanonicalChangeCommitted), so a rolled-back write
 * propagates nothing.
 */

export const CANONICAL_CHANGED_EVENT = "canonical:changed";

export type CanonicalChangeOp =
  /** A key that had no row at all got its first value. */
  | "add"
  /** A new value replaced the current (or retired) one; the old row is history. */
  | "supersede"
  /** The current value stopped being injected. */
  | "retire"
  /** The owner lifted a retirement; the retired value is current again. */
  | "unretire"
  /** A pin restated a retired value and brought it back. */
  | "reactivate";

export type CanonicalChangeEvent = {
  key: string;
  /** The value that stopped being current (null for `add`, `unretire`, `reactivate`). */
  oldValue: string | null;
  /** The value that is current now (null for `retire`). */
  newValue: string | null;
  op: CanonicalChangeOp;
  /** Trust tier of the writer (owner 3, agent_pin 2, extraction 1, background 0). */
  tier: number;
  /** The writer: a CanonicalSource for pins, `owner` for unretire. */
  source: string;
  /** Retire only: owner | agent | decay | hygiene. */
  retireReason?: string;
  scope: string;
  evidence: { ref: string | null; chunkIds: string[] };
  /** The row that now carries the key's current state. */
  factId: string;
  at: number;
};

export type CanonicalChangeListener = (event: CanonicalChangeEvent) => void;

/**
 * Should this change rewrite what other stores say about the key? An add has
 * nothing stale behind it, and a retire by the clock (decay) or by hygiene
 * means "unconfirmed", not "false". The agent's own retire is "stop
 * injecting", not a correction. Only a value replacement or the owner's
 * retire makes the old value wrong; a value coming back (unretire,
 * reactivate, a supersede back to an earlier value) clears earlier marks.
 */
export function canonicalChangeMarksStale(event: CanonicalChangeEvent): boolean {
  if (!event.oldValue) {
    return false;
  }
  if (event.op === "supersede") {
    return event.oldValue !== event.newValue;
  }
  return event.op === "retire" && event.retireReason === "owner";
}
