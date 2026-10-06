/**
 * While the gateway types a card into a checkout page, nothing may capture
 * that page (PLAN-53 A2/A6 with Track C): the live view sends no frames and
 * session replay records none. The `purchase` tool opens the window when it
 * fills a card; it closes on its own after CARD_ENTRY_WINDOW_MS, which covers
 * submitting the order and the confirmation page.
 *
 * Kept on globalThis so every bundle that loads this module shares one clock.
 */

export const CARD_ENTRY_WINDOW_MS = 10 * 60 * 1000;

const KEY = Symbol.for("bitterbot.cardEntryUntil");
type Holder = { [KEY]?: number };

/** Start (or extend) the window in which the browser must not be captured. */
export function markCardEntry(now = Date.now()): void {
  (globalThis as Holder)[KEY] = now + CARD_ENTRY_WINDOW_MS;
}

/** True while a card may be visible on the agent's page. */
export function cardEntryActive(now = Date.now()): boolean {
  return ((globalThis as Holder)[KEY] ?? 0) > now;
}

export function resetCardEntryForTest(): void {
  delete (globalThis as Holder)[KEY];
}
