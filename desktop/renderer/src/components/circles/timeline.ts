import type { CircleMessage } from "../../stores/circles-store";

// Phase A (readable timeline): pure layout logic for the circle conversation
// stream — consecutive-message grouping, day dividers, and the frozen "New"
// divider. Kept free of React so the rules are unit-testable; the component
// renders whatever this module decides.

/**
 * Messages from the same author within this window collapse into one visual
 * group: the follow-ups drop their avatar + header and show a hover-revealed
 * timestamp in the gutter instead. Beyond it a message reads as a new thought
 * and gets the full header again.
 */
export const GROUPING_WINDOW_MS = 10 * 60 * 1000;

export type TimelineItem =
  | { type: "day"; ts: number; label: string }
  | { type: "unread" }
  | { type: "message"; message: CircleMessage; isContinuation: boolean };

/** Same local calendar day (day dividers + grouping never cross midnight). */
export function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "Today" / "Yesterday" / "Monday, March 31" (+ ", 2025" for prior years). */
export function dayLabel(ts: number, now: number): string {
  if (sameLocalDay(ts, now)) return "Today";
  if (sameLocalDay(ts, now - 24 * 60 * 60 * 1000)) return "Yesterday";
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date(now).getFullYear()
      ? { weekday: "long", month: "long", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Full date+time for timestamp tooltips. */
export function fmtFullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A message can continue the previous one's group only when both are plain,
 * living chat messages from the same author (human vs agent counts as a
 * different author), close together, on the same day. Replies keep their
 * header — the quote banner needs an anchor — and undelivered sends keep
 * theirs so the transient state never collapses into a silent tail.
 */
export function isContinuation(prev: CircleMessage | undefined, m: CircleMessage): boolean {
  if (!prev) return false;
  if (prev.deleted || m.deleted) return false;
  if (prev.kind !== "message" || m.kind !== "message") return false;
  if (m.replyTo) return false;
  if (prev.authorPubkey !== m.authorPubkey) return false;
  if ((prev.agentAuthored === true) !== (m.agentAuthored === true)) return false;
  if (m.deliveryStatus && m.deliveryStatus !== "delivered") return false;
  if (!sameLocalDay(prev.createdAt, m.createdAt)) return false;
  return m.createdAt - prev.createdAt <= GROUPING_WINDOW_MS;
}

/**
 * Fold messages (chronological) into render items: a day divider before each
 * new local day, the frozen "New" divider before the first inbound message
 * newer than `readFrontier`, and per-message continuation flags.
 *
 * `readFrontier` is the circle's read marker AS IT STOOD WHEN THE CIRCLE WAS
 * OPENED — frozen so the line doesn't slide away while the human reads.
 * A frontier of 0 on a circle with history means "never read": everything
 * inbound is new, and the divider sits above the first inbound message.
 */
export function buildTimeline(
  messages: CircleMessage[],
  readFrontier: number | undefined,
  now: number = Date.now(),
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let prev: CircleMessage | undefined;
  let unreadPlaced = false;
  const frontier = readFrontier ?? Number.MAX_SAFE_INTEGER;
  for (const m of messages) {
    if (!prev || !sameLocalDay(prev.createdAt, m.createdAt)) {
      items.push({ type: "day", ts: m.createdAt, label: dayLabel(m.createdAt, now) });
      prev = undefined; // a new day always restarts the group
    }
    if (!unreadPlaced && m.direction === "in" && m.createdAt > frontier) {
      items.push({ type: "unread" });
      unreadPlaced = true;
      prev = undefined; // the divider visually severs the group too
    }
    items.push({ type: "message", message: m, isContinuation: isContinuation(prev, m) });
    prev = m;
  }
  return items;
}
