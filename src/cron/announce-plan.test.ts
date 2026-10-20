import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { NO_ANNOUNCE_TARGET, resolveAnnouncePlan as resolvePlan } from "./announce-plan.js";

// Every target is deliverable here; the channel's own check has its own tests.
const resolveAnnouncePlan = (params: Parameters<typeof resolvePlan>[0]) =>
  resolvePlan({ checkTarget: ({ to }) => ({ ok: true, to }), ...params });

const withLastRoute = {
  sessionId: "s1",
  updatedAt: 0,
  lastChannel: "telegram",
  lastTo: "12345",
} as unknown as SessionEntry;

describe("resolveAnnouncePlan", () => {
  it("does nothing for delivery.mode none", () => {
    expect(resolveAnnouncePlan({ delivery: { mode: "none" }, mainEntry: withLastRoute })).toEqual({
      kind: "none",
    });
  });

  it("uses an explicit channel and target", () => {
    expect(
      resolveAnnouncePlan({ delivery: { mode: "announce", channel: "telegram", to: "999" } }),
    ).toMatchObject({ kind: "deliver", channel: "telegram", to: "999" });
  });

  it("falls back to the main session's last route when no target is given", () => {
    // What the Control UI creates: no delivery block at all.
    expect(resolveAnnouncePlan({ mainEntry: withLastRoute })).toMatchObject({
      kind: "deliver",
      channel: "telegram",
      to: "12345",
    });
    // `channel: last` is the documented spelling of the same thing.
    expect(
      resolveAnnouncePlan({
        delivery: { mode: "announce", channel: "last" },
        mainEntry: withLastRoute,
      }),
    ).toMatchObject({ kind: "deliver", channel: "telegram", to: "12345" });
  });

  it("keeps the result in the main session when a default job has no route at all", () => {
    expect(resolveAnnouncePlan({})).toMatchObject({ kind: "main-only" });
    expect(
      resolveAnnouncePlan({ mainEntry: { sessionId: "s1", updatedAt: 0 } as SessionEntry }),
    ).toMatchObject({ kind: "main-only" });
  });

  it("fails before the turn when announce was asked for and no target can be found", () => {
    expect(() => resolveAnnouncePlan({ delivery: { mode: "announce" } })).toThrow(
      NO_ANNOUNCE_TARGET,
    );
    expect(() =>
      resolveAnnouncePlan({ delivery: { mode: "announce", channel: "telegram" } }),
    ).toThrow(NO_ANNOUNCE_TARGET);
  });

  it("does not fail a best-effort job without a target", () => {
    expect(resolveAnnouncePlan({ delivery: { mode: "announce", bestEffort: true } })).toMatchObject(
      { kind: "main-only" },
    );
  });

  it("does not send to another channel's last target", () => {
    // The last route is Telegram; asking for WhatsApp without a target must
    // not reuse the Telegram chat id as a phone number.
    expect(() =>
      resolveAnnouncePlan({
        delivery: { mode: "announce", channel: "whatsapp" },
        mainEntry: withLastRoute,
      }),
    ).toThrow(NO_ANNOUNCE_TARGET);
  });
  it("falls back to the main session when the channel rejects the target", () => {
    const rejecting = {
      checkTarget: () => ({ ok: false as const, error: new Error("not allowed") }),
    };
    expect(resolvePlan({ mainEntry: withLastRoute, ...rejecting })).toMatchObject({
      kind: "main-only",
      reason: expect.stringContaining("not allowed"),
    });
    expect(() =>
      resolvePlan({
        delivery: { mode: "announce", channel: "telegram", to: "999" },
        ...rejecting,
      }),
    ).toThrow(NO_ANNOUNCE_TARGET);
  });

  it("checks a last-route target as a fallback and an explicit one as explicit", () => {
    const seen: boolean[] = [];
    const checkTarget = ({ to, fromLastRoute }: { to: string; fromLastRoute: boolean }) => {
      seen.push(fromLastRoute);
      return { ok: true as const, to };
    };
    resolvePlan({ mainEntry: withLastRoute, checkTarget });
    resolvePlan({ delivery: { mode: "announce", channel: "telegram", to: "999" }, checkTarget });
    expect(seen).toEqual([true, false]);
  });
});
