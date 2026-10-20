import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import {
  isOwnerQuietHours,
  notifyOwner,
  type OwnerNotifyDeps,
  resetOwnerNotifyForTest,
  resolveOwnerPushTarget,
} from "./owner-notify.js";

/**
 * The rule under test: a notice may be held back from a chat channel, but it
 * is never lost. It always reaches the main session and the UI.
 */

let now: number;
let session: string[];
let ui: Array<{ kind: string; text: string }>;
let sent: Array<{ to: string; text: string }>;

const deps = (extra: Partial<OwnerNotifyDeps> = {}): Partial<OwnerNotifyDeps> => ({
  cfg: {} as BitterbotConfig,
  now: () => now,
  toSession: (text) => session.push(text),
  toUi: (payload) => ui.push(payload),
  resolveTarget: () => ({ channel: "telegram", to: "42" }),
  send: async (target, text) => {
    sent.push({ to: target.to, text });
  },
  inQuietHours: () => false,
  ...extra,
});

beforeEach(() => {
  resetOwnerNotifyForTest();
  now = Date.UTC(2026, 9, 5, 15, 0, 0);
  session = [];
  ui = [];
  sent = [];
});

describe("notifyOwner", () => {
  it("puts the notice in the session and the UI, and pushes it", async () => {
    const result = await notifyOwner({ kind: "cron-error", text: "Job failed." }, deps());

    expect(result).toEqual({ pushed: "channel" });
    expect(session).toEqual(["[notice] Job failed."]);
    expect(ui).toMatchObject([{ kind: "cron-error", text: "Job failed." }]);
    expect(sent).toEqual([{ to: "42", text: "Job failed." }]);
  });

  it("keeps the notice when there is nowhere to push it", async () => {
    const result = await notifyOwner(
      { kind: "cron-error", text: "Job failed." },
      deps({ resolveTarget: () => null }),
    );

    expect(result).toEqual({ pushed: "none", reason: "no-target" });
    expect(session).toHaveLength(1);
    expect(ui).toHaveLength(1);
  });

  it("holds the push in quiet hours but still records the notice", async () => {
    const result = await notifyOwner(
      { kind: "cron-error", text: "Job failed." },
      deps({ inQuietHours: () => true }),
    );

    expect(result).toEqual({ pushed: "none", reason: "quiet-hours" });
    expect(sent).toHaveLength(0);
    expect(session).toHaveLength(1);
  });

  it("stops pushing at the hourly limit, then resumes an hour later", async () => {
    const limited = deps({ cfg: { notifications: { maxPerHour: 2 } } as BitterbotConfig });

    for (let i = 0; i < 4; i += 1) {
      await notifyOwner({ kind: "cron-error", text: `Failure ${i}.` }, limited);
    }
    expect(sent).toHaveLength(2);
    expect(session).toHaveLength(4);

    now += 61 * 60_000;
    expect(await notifyOwner({ kind: "cron-error", text: "Later." }, limited)).toEqual({
      pushed: "channel",
    });
  });

  it("says a thing once: the same key inside the window is dropped entirely", async () => {
    const notice = { kind: "cron-error", text: "Job failed.", dedupeKey: "cron-error:j1" };

    await notifyOwner(notice, deps());
    expect(await notifyOwner(notice, deps())).toEqual({ pushed: "none", reason: "duplicate" });
    expect(session).toHaveLength(1);

    now += 31 * 60_000;
    expect((await notifyOwner(notice, deps())).pushed).toBe("channel");
  });

  it("survives a channel that refuses the message", async () => {
    const send = vi.fn(async () => {
      throw new Error("blocked by the user");
    });

    const result = await notifyOwner({ kind: "cron-error", text: "Job failed." }, deps({ send }));

    expect(result).toEqual({ pushed: "none", reason: "send-failed" });
    expect(session).toHaveLength(1);
  });
});

describe("isOwnerQuietHours", () => {
  const cfg = (start: string, end: string) =>
    ({ notifications: { quietHours: { start, end, timezone: "UTC" } } }) as BitterbotConfig;
  const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 5, hour, minute);

  it("covers a window inside one day", () => {
    expect(isOwnerQuietHours(cfg("13:00", "14:30"), at(13, 15))).toBe(true);
    expect(isOwnerQuietHours(cfg("13:00", "14:30"), at(14, 30))).toBe(false);
  });

  it("covers a window that runs past midnight", () => {
    expect(isOwnerQuietHours(cfg("22:00", "07:00"), at(23))).toBe(true);
    expect(isOwnerQuietHours(cfg("22:00", "07:00"), at(6, 59))).toBe(true);
    expect(isOwnerQuietHours(cfg("22:00", "07:00"), at(12))).toBe(false);
  });

  it("is never quiet without a usable window, or with a timezone it does not know", () => {
    expect(isOwnerQuietHours({} as BitterbotConfig, at(3))).toBe(false);
    expect(isOwnerQuietHours(cfg("22:00", "22:00"), at(22))).toBe(false);
    expect(isOwnerQuietHours(cfg("late", "early"), at(3))).toBe(false);
    expect(
      isOwnerQuietHours(
        {
          notifications: { quietHours: { start: "00:00", end: "23:59", timezone: "Mars/Olympus" } },
        },
        at(3),
      ),
    ).toBe(false);
  });
});

describe("resolveOwnerPushTarget", () => {
  it("uses the configured owner target as written", async () => {
    expect(
      await resolveOwnerPushTarget({
        notifications: { owner: { channel: " Telegram ", to: " 42 " } },
      } as BitterbotConfig),
    ).toEqual({ channel: "telegram", to: "42", accountId: undefined });
  });
});
