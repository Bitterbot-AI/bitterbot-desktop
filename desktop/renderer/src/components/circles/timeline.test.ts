import { describe, expect, it } from "vitest";
import { mergeMessages, type CircleMessage } from "../../stores/circles-store";
import {
  buildTimeline,
  dayLabel,
  GROUPING_WINDOW_MS,
  isContinuation,
  sameLocalDay,
} from "./timeline";

// Phase A (readable timeline): the pure layout rules — grouping, day
// dividers, the frozen "New" divider, and the poll-vs-history message merge.

const NOON = new Date(2026, 7, 7, 12, 0, 0).getTime(); // local Aug 7 2026 12:00

function msg(over: Partial<CircleMessage>): CircleMessage {
  return {
    messageId: over.messageId ?? `m-${Math.abs(over.createdAt ?? 0)}`,
    authorPubkey: "ed25519:maya",
    direction: "in",
    kind: "message",
    content: "hi",
    createdAt: NOON,
    ...over,
  };
}

describe("sameLocalDay / dayLabel", () => {
  it("splits days on local midnight", () => {
    const lateNight = new Date(2026, 7, 6, 23, 59).getTime();
    const earlyMorning = new Date(2026, 7, 7, 0, 1).getTime();
    expect(sameLocalDay(lateNight, earlyMorning)).toBe(false);
    expect(sameLocalDay(earlyMorning, NOON)).toBe(true);
  });

  it("labels today, yesterday, same-year weekday, and prior years", () => {
    expect(dayLabel(NOON, NOON)).toBe("Today");
    expect(dayLabel(NOON - 24 * 60 * 60 * 1000, NOON)).toBe("Yesterday");
    // Calendar day, not 24 elapsed hours: catches DST/naive-arithmetic bugs.
    const sep1 = new Date(2026, 8, 1, 0, 30).getTime();
    const aug31 = new Date(2026, 7, 31, 23, 0).getTime();
    expect(dayLabel(aug31, sep1)).toBe("Yesterday");
    const march = new Date(2026, 2, 31, 9, 0).getTime();
    expect(dayLabel(march, NOON)).toMatch(/March 31/);
    expect(dayLabel(march, NOON)).not.toMatch(/2026/);
    const lastYear = new Date(2025, 2, 31, 9, 0).getTime();
    expect(dayLabel(lastYear, NOON)).toMatch(/2025/);
  });
});

describe("isContinuation", () => {
  const prev = msg({ messageId: "a", createdAt: NOON });

  it("groups same-author messages inside the window", () => {
    expect(isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 60_000 }))).toBe(true);
  });

  it("breaks the group beyond the window, across authors, and across days", () => {
    expect(
      isContinuation(prev, msg({ messageId: "b", createdAt: NOON + GROUPING_WINDOW_MS + 1 })),
    ).toBe(false);
    expect(
      isContinuation(
        prev,
        msg({ messageId: "b", createdAt: NOON + 1, authorPubkey: "ed25519:other" }),
      ),
    ).toBe(false);
    const prevNight = msg({ messageId: "a", createdAt: new Date(2026, 7, 6, 23, 59).getTime() });
    const nextMorning = msg({ messageId: "b", createdAt: new Date(2026, 7, 7, 0, 0).getTime() });
    expect(isContinuation(prevNight, nextMorning)).toBe(false);
  });

  it("a wrap-status flip restarts the group (the shield lives in the header)", () => {
    const wrapped = [
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
      "Source: peer",
      "---",
      "hello",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    expect(
      isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, content: wrapped })),
    ).toBe(false);
    // Homogeneous wrapped runs still group — the group header carries the cue.
    expect(
      isContinuation(
        msg({ messageId: "a", createdAt: NOON, content: wrapped }),
        msg({ messageId: "b", createdAt: NOON + 1, content: wrapped }),
      ),
    ).toBe(true);
  });

  it("a human and their agent never group, even same pubkey", () => {
    expect(
      isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, agentAuthored: true })),
    ).toBe(false);
  });

  it("replies, system rows, tombstones, and undelivered sends keep their header", () => {
    expect(isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, replyTo: "env" }))).toBe(
      false,
    );
    expect(isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, kind: "system" }))).toBe(
      false,
    );
    expect(isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, deleted: true }))).toBe(
      false,
    );
    expect(
      isContinuation(prev, msg({ messageId: "b", createdAt: NOON + 1, deliveryStatus: "pending" })),
    ).toBe(false);
    expect(isContinuation(undefined, msg({ messageId: "b" }))).toBe(false);
  });
});

describe("buildTimeline", () => {
  it("inserts a day divider per local day and restarts groups across it", () => {
    const yesterday = new Date(2026, 7, 6, 22, 0).getTime();
    const items = buildTimeline(
      [
        msg({ messageId: "a", createdAt: yesterday }),
        msg({ messageId: "b", createdAt: NOON }),
        msg({ messageId: "c", createdAt: NOON + 1000 }),
      ],
      undefined,
      NOON,
    );
    expect(items.map((i) => i.type)).toEqual(["day", "message", "day", "message", "message"]);
    // b opens the new day with a full header even though a is the same author.
    const b = items[3] as { type: "message"; isContinuation: boolean };
    const c = items[4] as { type: "message"; isContinuation: boolean };
    expect(b.isContinuation).toBe(false);
    expect(c.isContinuation).toBe(true);
  });

  it("places the New divider before the first inbound past the frontier, once", () => {
    const items = buildTimeline(
      [
        msg({ messageId: "a", createdAt: NOON }),
        msg({ messageId: "b", createdAt: NOON + 1000 }),
        msg({ messageId: "c", createdAt: NOON + 2000 }),
      ],
      NOON + 500,
      NOON,
    );
    expect(items.map((i) => i.type)).toEqual(["day", "message", "unread", "message", "message"]);
    // The divider severs the visual group: b restarts with a full header.
    const b = items[3] as { type: "message"; isContinuation: boolean };
    expect(b.isContinuation).toBe(false);
  });

  it("own outbound messages never trigger the New divider", () => {
    const items = buildTimeline(
      [
        msg({ messageId: "a", createdAt: NOON }),
        msg({ messageId: "b", createdAt: NOON + 1000, direction: "out" }),
      ],
      NOON + 500,
      NOON,
    );
    expect(items.some((i) => i.type === "unread")).toBe(false);
  });

  it("no frontier (undefined) means nothing is marked new", () => {
    const items = buildTimeline([msg({ messageId: "a" })], undefined, NOON);
    expect(items.some((i) => i.type === "unread")).toBe(false);
  });

  it("frontier 0 (never read) marks all inbound as new", () => {
    const items = buildTimeline([msg({ messageId: "a" })], 0, NOON);
    expect(items.map((i) => i.type)).toEqual(["day", "unread", "message"]);
  });
});

describe("mergeMessages", () => {
  it("unions by id, keeps chronological order, incoming wins collisions", () => {
    const older = [
      msg({ messageId: "a", createdAt: 1000 }),
      msg({ messageId: "b", createdAt: 2000 }),
    ];
    const window = [
      msg({ messageId: "b", createdAt: 2000, deleted: true }),
      msg({ messageId: "c", createdAt: 3000 }),
    ];
    const merged = mergeMessages(older, window);
    expect(merged.map((m) => m.messageId)).toEqual(["a", "b", "c"]);
    expect(merged[1]?.deleted).toBe(true);
  });

  it("keeps older pages when the poll window no longer contains them", () => {
    const history = [msg({ messageId: "old", createdAt: 500 })];
    const window = [msg({ messageId: "new", createdAt: 9000 })];
    expect(mergeMessages(history, window).map((m) => m.messageId)).toEqual(["old", "new"]);
  });

  it("is reference-stable: idle polls return the existing array untouched", () => {
    const existing = [
      msg({ messageId: "a", createdAt: 1000 }),
      msg({ messageId: "b", createdAt: 2000 }),
    ];
    // The poll always parses fresh objects with identical content.
    const freshCopies = existing.map((m) => ({ ...m }));
    expect(mergeMessages(existing, freshCopies)).toBe(existing);
  });

  it("keeps unchanged message refs when only one message changed", () => {
    const a = msg({ messageId: "a", createdAt: 1000 });
    const b = msg({ messageId: "b", createdAt: 2000 });
    const merged = mergeMessages([a, b], [{ ...b, deleted: true }]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).not.toBe(b);
    expect(merged[1]?.deleted).toBe(true);
  });
});
