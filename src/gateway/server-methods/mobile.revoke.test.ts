import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("../../infra/device-pairing.js", () => ({
  getPairedDevice: vi.fn(),
  removePairedDevice: vi.fn(async (deviceId: string) => {
    calls.push("removePairing");
    return { deviceId };
  }),
  renamePairedDevice: vi.fn(),
}));
vi.mock("../mobile/live-clients.js", () => ({
  deviceIdOf: vi.fn(),
  disconnectDevice: vi.fn(() => calls.push("disconnect")),
}));
vi.mock("../mobile/push-dispatcher.js", () => ({
  getActivePushDispatcher: () => ({ forgetDevice: () => calls.push("forget") }),
  loadVapidKeys: vi.fn(),
  pushEnabled: vi.fn(),
}));
vi.mock("../mobile/push-store.js", () => ({
  DEFAULT_PUSH_CATEGORIES: {},
  getPushSubscription: vi.fn(),
  removePushSubscription: vi.fn(async () => {
    calls.push("removePush");
    throw new Error("EACCES: subscriptions.json");
  }),
  updatePushCategories: vi.fn(),
  upsertPushSubscription: vi.fn(),
  validateSubscriptionInput: vi.fn(),
}));

const { removeDeviceEverywhere } = await import("./mobile.js");

describe("removing a phone (PLAN-62)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("closes its sockets even when push cleanup fails", async () => {
    await expect(removeDeviceEverywhere("dev-a")).resolves.toEqual({ deviceId: "dev-a" });
    expect(calls).toEqual(["removePairing", "forget", "disconnect", "removePush"]);
  });
});
