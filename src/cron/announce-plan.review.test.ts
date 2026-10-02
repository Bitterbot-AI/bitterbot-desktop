/**
 * From the adversarial review of the pre-turn delivery plan for isolated
 * cron jobs. Each test pins a defect the review found, now fixed.
 */

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveAnnouncePlan } from "./announce-plan.js";

const allow = { checkTarget: ({ to }: { to: string }) => ({ ok: true as const, to }) };

describe("resolveAnnouncePlan (review)", () => {
  it("an explicit target does not inherit the last route's thread or account", () => {
    // Main session's last route: a DM thread on the "work" Slack account.
    const mainEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastChannel: "slack",
      lastTo: "D0OWNER",
      lastAccountId: "work",
      lastThreadId: "1727800000.000100",
    } as unknown as SessionEntry;
    const plan = resolveAnnouncePlan({
      delivery: { mode: "announce", channel: "slack", to: "C0TEAMCHANNEL" },
      mainEntry,
      ...allow,
    });
    expect(plan).toEqual({ kind: "deliver", channel: "slack", to: "C0TEAMCHANNEL" });
  });

  it("the last-route fallback keeps that route's thread and account", () => {
    const mainEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastChannel: "slack",
      lastTo: "D0OWNER",
      lastAccountId: "work",
      lastThreadId: "1727800000.000100",
    } as unknown as SessionEntry;
    expect(resolveAnnouncePlan({ mainEntry, ...allow })).toEqual({
      kind: "deliver",
      channel: "slack",
      to: "D0OWNER",
      accountId: "work",
      threadId: "1727800000.000100",
    });
  });

  it("an explicit `to` without a channel is not sent on whatever channel the last route used", () => {
    const mainEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastChannel: "telegram",
      lastTo: "12345",
    } as unknown as SessionEntry;
    expect(() =>
      resolveAnnouncePlan({
        delivery: { mode: "announce", to: "+15551234567" },
        mainEntry,
        ...allow,
      }),
    ).toThrow(/delivery.to needs delivery.channel/);
  });

  it("a last route on a channel that is not loaded is not planned for delivery", () => {
    // The plan used to say "deliver", the turn ran, and the send then threw
    // "Outbound not configured for channel": a default job failed every run
    // after paying for the model call.
    const mainEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastChannel: "telegram",
      lastTo: "12345",
    } as unknown as SessionEntry;
    const previous = getActivePluginRegistry();
    setActivePluginRegistry(createTestRegistry([]));
    try {
      // The real channel check, with no Telegram plugin registered.
      expect(resolveAnnouncePlan({ mainEntry })).toMatchObject({ kind: "main-only" });
      expect(() =>
        resolveAnnouncePlan({ delivery: { mode: "announce", channel: "last" }, mainEntry }),
      ).toThrow(/not deliverable/);
    } finally {
      if (previous) {
        setActivePluginRegistry(previous);
      }
    }
  });
});
