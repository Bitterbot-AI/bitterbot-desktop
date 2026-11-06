import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import {
  buildPushFromEvent,
  createPushDispatcher,
  generateVapidKeyPair,
  type PushSendFn,
} from "./push-dispatcher.js";
import {
  getPushSubscription,
  isAllowedPushEndpoint,
  listPushSubscriptions,
  loadOrCreateVapidKeys,
  recordPushOutcome,
  removePushSubscription,
  updatePushCategories,
  upsertPushSubscription,
  validateSubscriptionInput,
  type StoredPushSubscription,
} from "./push-store.js";

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-push-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const APPLE = "https://web.push.apple.com/QGuQyavXutnMH_xkzE5Ig5ey";

describe("push subscriptions (PLAN-62)", () => {
  it("only accepts endpoints at real push services", () => {
    expect(isAllowedPushEndpoint(APPLE)).toBe(true);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(
      true,
    );
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    // SSRF shapes: internal hosts, http, look-alike domains, credentials, odd ports.
    expect(isAllowedPushEndpoint("http://web.push.apple.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evilpush.apple.com.attacker.net/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://notpush.apple.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@web.push.apple.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://web.push.apple.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://push.example.org/x", ["push.example.org"])).toBe(true);
  });

  it("validates subscription keys", () => {
    expect(validateSubscriptionInput({ endpoint: APPLE, keys: KEYS }).ok).toBe(true);
    expect(
      validateSubscriptionInput({ endpoint: APPLE, keys: { p256dh: "x y", auth: "a" } }).ok,
    ).toBe(false);
    expect(validateSubscriptionInput({ endpoint: APPLE }).ok).toBe(false);
    expect(validateSubscriptionInput({ endpoint: "https://10.0.0.1/x", keys: KEYS }).ok).toBe(
      false,
    );
  });

  it("stores one subscription per device and deletes it on revoke", async () => {
    await upsertPushSubscription({ deviceId: "dev-a", endpoint: APPLE, keys: KEYS }, dir);
    await upsertPushSubscription(
      { deviceId: "dev-a", endpoint: `${APPLE}-2`, keys: KEYS, categories: { replies: false } },
      dir,
    );
    await upsertPushSubscription({ deviceId: "dev-b", endpoint: APPLE, keys: KEYS }, dir);
    const subs = await listPushSubscriptions(dir);
    expect(subs).toHaveLength(2);
    const a = await getPushSubscription("dev-a", dir);
    expect(a?.endpoint).toBe(`${APPLE}-2`);
    expect(a?.categories).toEqual({
      approvals: true,
      replies: false,
      notices: true,
      previews: true,
    });

    await updatePushCategories("dev-a", { previews: false, bogus: true } as never, dir);
    expect((await getPushSubscription("dev-a", dir))?.categories.previews).toBe(false);

    expect(await removePushSubscription("dev-a", dir)).toBe(true);
    expect(await getPushSubscription("dev-a", dir)).toBeNull();
    expect(await removePushSubscription("dev-a", dir)).toBe(false);
    const stat = await fs.stat(path.join(dir, "push", "subscriptions.json"));
    expect(stat.mode & 0o077).toBe(0);
  });

  it("drops a subscription the push service says is gone", async () => {
    await upsertPushSubscription({ deviceId: "dev-a", endpoint: APPLE, keys: KEYS }, dir);
    await recordPushOutcome("dev-a", { ok: false, gone: false }, dir);
    expect((await getPushSubscription("dev-a", dir))?.failures).toBe(1);
    await recordPushOutcome("dev-a", { ok: false, gone: true }, dir);
    expect(await getPushSubscription("dev-a", dir)).toBeNull();
  });

  it("generates VAPID keys once, privately, in the state dir", async () => {
    const generate = vi.fn(generateVapidKeyPair);
    const first = await loadOrCreateVapidKeys({ baseDir: dir, generate });
    const second = await loadOrCreateVapidKeys({ baseDir: dir, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(second.publicKey).toBe(first.publicKey);
    expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(first.privateKey, "base64url")).toHaveLength(32);
    const stat = await fs.stat(path.join(dir, "push", "vapid.json"));
    expect(stat.mode & 0o077).toBe(0);
  });
});

describe("push payloads (PLAN-62)", () => {
  it("turns a held action into a deep-linked approval notification", () => {
    const built = buildPushFromEvent("review.requested", {
      id: "rv-1",
      status: "pending",
      cls: "command",
      preview: "rm -rf build && make",
    });
    expect(built?.category).toBe("approvals");
    expect(built?.payload).toMatchObject({
      kind: "approval",
      title: "A shell command needs your OK",
      body: "rm -rf build && make",
      tag: "review-rv-1",
      url: "#/approvals?id=rv-1",
    });
  });

  it("previews a final reply briefly and ignores deltas", () => {
    expect(
      buildPushFromEvent("chat", { state: "delta", sessionKey: "s", message: { content: "x" } }),
    ).toBeNull();
    const long = "word ".repeat(100);
    const built = buildPushFromEvent("chat", {
      state: "final",
      sessionKey: "agent:main:default",
      message: { role: "assistant", content: [{ type: "text", text: long }] },
    });
    expect(built?.payload.body.length).toBeLessThanOrEqual(90);
    expect(built?.payload.url).toBe(`#/chat?session=${encodeURIComponent("agent:main:default")}`);
  });

  it("ignores events it does not send", () => {
    expect(buildPushFromEvent("exec.approval.requested", { id: "x" })).toBeNull();
    expect(buildPushFromEvent("agent", { runId: "r" })).toBeNull();
    expect(buildPushFromEvent("owner.notice", { text: "  " })).toBeNull();
  });
});

describe("push dispatcher (PLAN-62)", () => {
  const cfg = { gateway: { mobile: { push: { maxPerHour: 2 } } } } as BitterbotConfig;
  const sub = (
    deviceId: string,
    categories: Partial<StoredPushSubscription["categories"]> = {},
  ): StoredPushSubscription => ({
    id: deviceId,
    deviceId,
    endpoint: APPLE,
    keys: KEYS,
    createdAtMs: 0,
    categories: { approvals: true, replies: true, notices: true, previews: true, ...categories },
  });

  function setup(
    subs: StoredPushSubscription[],
    opts: { foreground?: string[]; inactive?: string[] } = {},
  ) {
    const sent: Array<{ deviceId: string; body: Record<string, unknown> }> = [];
    const send: PushSendFn = async (s, payload) => {
      sent.push({ deviceId: s.deviceId, body: JSON.parse(payload) as Record<string, unknown> });
      return { ok: true };
    };
    const dispatcher = createPushDispatcher({
      send,
      getConfig: () => cfg,
      listSubscriptions: async () => subs,
      isForeground: (id) => opts.foreground?.includes(id) ?? false,
      getVapid: async () => ({ publicKey: "p", privateKey: "k", createdAtMs: 0 }),
      recordOutcome: async () => {},
      isDeviceActive: async (id) => !opts.inactive?.includes(id),
      now: () => Date.UTC(2026, 10, 5, 12),
    });
    return { dispatcher, sent };
  }

  const approval = {
    id: "rv-9",
    status: "pending",
    cls: "command",
    preview: "ls -la ~/secret-project",
  };

  it("sends approvals to subscribed devices that are not looking at the app", async () => {
    const { dispatcher, sent } = setup([sub("a"), sub("b"), sub("c", { approvals: false })], {
      foreground: ["b"],
    });
    expect(await dispatcher.dispatch("review.requested", approval)).toBe(1);
    expect(sent.map((s) => s.deviceId)).toEqual(["a"]);
  });

  it("replaces the preview with a generic line when previews are off", async () => {
    const { dispatcher, sent } = setup([sub("a", { previews: false })]);
    await dispatcher.dispatch("review.requested", approval);
    expect(sent[0]?.body.body).toBe("Tap to review.");
    expect(JSON.stringify(sent[0]?.body)).not.toContain("secret-project");
  });

  it("only pushes replies for sessions the phone sent to", async () => {
    const { dispatcher, sent } = setup([sub("a"), sub("b")]);
    dispatcher.noteChatSend("a", "default");
    const final = { state: "final", sessionKey: "default", message: { content: "done" } };
    expect(await dispatcher.dispatch("chat", final)).toBe(1);
    expect(sent.map((s) => s.deviceId)).toEqual(["a"]);
    dispatcher.forgetDevice("a");
    expect(await dispatcher.dispatch("chat", final)).toBe(0);
  });

  it("enforces the per-device hourly budget", async () => {
    const { dispatcher, sent } = setup([sub("a")]);
    await dispatcher.dispatch("review.requested", { ...approval, id: "1" });
    await dispatcher.dispatch("review.requested", { ...approval, id: "2" });
    await dispatcher.dispatch("review.requested", { ...approval, id: "3" });
    expect(sent).toHaveLength(2);
  });

  it("sends nothing when push is turned off", async () => {
    const subs = [sub("a")];
    const dispatcher = createPushDispatcher({
      send: async () => ({ ok: true }),
      getConfig: () => ({ gateway: { mobile: { push: { enabled: false } } } }) as BitterbotConfig,
      listSubscriptions: async () => subs,
      isForeground: () => false,
      getVapid: async () => ({ publicKey: "p", privateKey: "k", createdAtMs: 0 }),
      recordOutcome: async () => {},
      isDeviceActive: async () => true,
    });
    expect(await dispatcher.dispatch("review.requested", approval)).toBe(0);
  });

  it("never pushes to a device that is no longer paired", async () => {
    const { dispatcher, sent } = setup([sub("a"), sub("gone")], { inactive: ["gone"] });
    expect(await dispatcher.dispatch("review.requested", approval)).toBe(1);
    expect(sent.map((s) => s.deviceId)).toEqual(["a"]);
  });

  it("records a gone endpoint so the subscription is dropped", async () => {
    const outcomes: unknown[] = [];
    const dispatcher = createPushDispatcher({
      send: async () => ({ ok: false, statusCode: 410, gone: true, message: "gone" }),
      getConfig: () => cfg,
      listSubscriptions: async () => [sub("a")],
      isForeground: () => false,
      getVapid: async () => ({ publicKey: "p", privateKey: "k", createdAtMs: 0 }),
      recordOutcome: async (deviceId, outcome) => {
        outcomes.push({ deviceId, outcome });
      },
      isDeviceActive: async () => true,
    });
    expect(await dispatcher.dispatch("review.requested", approval)).toBe(0);
    expect(outcomes).toEqual([{ deviceId: "a", outcome: { ok: false, gone: true } }]);
  });
});
