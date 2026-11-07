/**
 * PLAN-62: which gateway events become a phone notification, and to whom.
 *
 * The dispatcher watches the gateway broadcast stream and turns three kinds of
 * event into Web Push:
 *
 *   - `review.requested`: something waits for the owner (a shell command, a
 *     message, a handoff). Exec approvals are mirrored into the review queue,
 *     so this one event covers them; `exec.approval.requested` is ignored to
 *     avoid a double buzz.
 *   - `chat` with state `final`: the agent finished a reply in a session this
 *     phone sent to recently, while the app is not on screen.
 *   - `owner.notice`: the existing owner notices (failed jobs, stranded tasks).
 *
 * A phone that has the app open and visible gets nothing: it already shows the
 * card. Each device has an hourly budget. During the owner's quiet hours,
 * replies and notices are counted instead of sent, and one summary goes out
 * when quiet hours end (approvals still go out: a held action is waiting on a
 * human). Payloads carry a title, a deep link and, only when the phone turned
 * previews on, a short preview of a reply or notice. An approval notification
 * never carries the command or any tool argument, whatever the setting:
 * truncation is not redaction, so its details are fetched over the
 * authenticated socket when the notification is opened.
 */

import { createECDH } from "node:crypto";
import { loadConfig, type BitterbotConfig } from "../../config/config.js";
import { getPairedDevice } from "../../infra/device-pairing.js";
import { isOwnerQuietHours } from "../../infra/owner-notify.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isDeviceForeground } from "./live-clients.js";
import {
  listPushSubscriptions,
  loadOrCreateVapidKeys,
  recordPushOutcome,
  type PushCategories,
  type StoredPushSubscription,
  type VapidKeys,
} from "./push-store.js";

const log = createSubsystemLogger("mobile-push");

export const DEFAULT_PUSH_MAX_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;
/** A device only gets reply pushes for sessions it sent to within this window. */
const REPLY_INTEREST_MS = 6 * 60 * 60_000;
const PREVIEW_CHARS = 90;
/** How often a held quiet-hours summary checks whether quiet hours ended. */
const HELD_FLUSH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_VAPID_SUBJECT = "https://github.com/Bitterbot-AI/bitterbot-desktop";

export type PushPayload = {
  kind: "approval" | "reply" | "notice" | "summary" | "test";
  title: string;
  body: string;
  /** Collapses repeats of the same thing into one notification. */
  tag: string;
  /** Where tapping lands, relative to the phone app (a hash route). */
  url: string;
  ts: number;
};

export type PushSendFn = (
  sub: StoredPushSubscription,
  payload: string,
  opts: { vapid: VapidKeys; subject: string; ttlSeconds: number; urgency: "high" | "normal" },
) => Promise<{ ok: true } | { ok: false; statusCode?: number; gone: boolean; message: string }>;

export function pushEnabled(cfg: BitterbotConfig): boolean {
  return cfg.gateway?.mobile?.enabled !== false && cfg.gateway?.mobile?.push?.enabled !== false;
}

/** The real sender: the web-push library, loaded on first use. */
export const webPushSend: PushSendFn = async (sub, payload, opts) => {
  const webpush = (await import("web-push")).default;
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
      vapidDetails: {
        subject: opts.subject,
        publicKey: opts.vapid.publicKey,
        privateKey: opts.vapid.privateKey,
      },
      TTL: opts.ttlSeconds,
      urgency: opts.urgency,
      contentEncoding: "aes128gcm",
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    return {
      ok: false,
      statusCode,
      gone: statusCode === 404 || statusCode === 410,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export async function loadVapidKeys(): Promise<VapidKeys> {
  return await loadOrCreateVapidKeys({ generate: generateVapidKeyPair });
}

/** A P-256 key pair encoded the way VAPID expects (raw public point, raw private scalar). */
export function generateVapidKeyPair(): { publicKey: string; privateKey: string } {
  // The same format web-push's generateVAPIDKeys() produces.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function textOfChatMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? (() => {
              const text = (part as { text?: unknown }).text;
              return typeof text === "string" ? text : "";
            })()
          : "",
      )
      .join(" ");
  }
  return "";
}

/** What kind of review row this is, in owner words. */
function describeReview(action: Record<string, unknown>): string {
  switch (action.cls) {
    case "command":
      return "A shell command needs your OK";
    case "spend":
      return "A payment needs your OK";
    case "publish":
      return "A public post needs your OK";
    case "contact":
      return "A message to someone new needs your OK";
    case "connector":
      return "A connected app action needs your OK";
    case "handoff":
      return "The agent wants you to take over the browser";
    default:
      return "Something needs your OK";
  }
}

export type BuiltPush = {
  payload: PushPayload;
  category: keyof PushCategories;
  sessionKey?: string;
};

/** Turn one broadcast into a push, or null when it is not one we send. */
export function buildPushFromEvent(
  event: string,
  raw: unknown,
  now = Date.now(),
): BuiltPush | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  if (event === "review.requested") {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id || (payload.status && payload.status !== "pending")) {
      return null;
    }
    return {
      category: "approvals",
      payload: {
        kind: "approval",
        title: describeReview(payload),
        body: "Tap to review.",
        tag: `review-${id}`,
        url: `#/approvals?id=${encodeURIComponent(id)}`,
        ts: now,
      },
    };
  }
  if (event === "owner.notice") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) {
      return null;
    }
    const kind = typeof payload.kind === "string" ? payload.kind : "notice";
    return {
      category: "notices",
      payload: {
        kind: "notice",
        title: "Bitterbot notice",
        body: truncate(text, PREVIEW_CHARS),
        tag: `notice-${kind}`,
        url: "#/status",
        ts: now,
      },
    };
  }
  if (event === "chat") {
    if (payload.state !== "final") {
      return null;
    }
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    const text = textOfChatMessage(payload.message).trim();
    if (!sessionKey || !text) {
      return null;
    }
    return {
      category: "replies",
      sessionKey,
      payload: {
        kind: "reply",
        title: "Bitterbot replied",
        body: truncate(text, PREVIEW_CHARS),
        tag: `reply-${sessionKey}`,
        url: `#/chat?session=${encodeURIComponent(sessionKey)}`,
        ts: now,
      },
    };
  }
  return null;
}

/** The generic line used when the owner turned previews off. */
function redactPreview(payload: PushPayload): PushPayload {
  const body =
    payload.kind === "approval"
      ? "Tap to review."
      : payload.kind === "reply"
        ? "Tap to read."
        : payload.kind === "notice"
          ? "Tap to see what happened."
          : payload.body;
  return { ...payload, body };
}

export type PushDispatcherDeps = {
  send?: PushSendFn;
  now?: () => number;
  getConfig?: () => BitterbotConfig;
  listSubscriptions?: () => Promise<StoredPushSubscription[]>;
  isForeground?: (deviceId: string) => boolean;
  getVapid?: () => Promise<VapidKeys>;
  recordOutcome?: typeof recordPushOutcome;
  /** Defense in depth: only push to a device that is still paired with a live token. */
  isDeviceActive?: (deviceId: string) => Promise<boolean>;
};

async function deviceStillPaired(deviceId: string): Promise<boolean> {
  const device = await getPairedDevice(deviceId);
  const token = device?.tokens?.operator;
  return Boolean(device && token && !token.revokedAtMs);
}

export function createPushDispatcher(deps: PushDispatcherDeps = {}) {
  const send = deps.send ?? webPushSend;
  const now = deps.now ?? (() => Date.now());
  const getConfig = deps.getConfig ?? (() => loadConfig());
  const list = deps.listSubscriptions ?? (() => listPushSubscriptions());
  const isForeground = deps.isForeground ?? isDeviceForeground;
  const getVapid = deps.getVapid ?? loadVapidKeys;
  const recordOutcome = deps.recordOutcome ?? recordPushOutcome;
  const isDeviceActive = deps.isDeviceActive ?? deviceStillPaired;
  /** deviceId -> send times inside the last hour. */
  const sentAt = new Map<string, number[]>();
  /** deviceId -> sessionKey -> last chat.send from that device. */
  const interest = new Map<string, Map<string, number>>();
  /** deviceId -> what quiet hours held back. Counts only, never content. */
  const held = new Map<string, { replies: number; notices: number }>();
  let heldTimer: ReturnType<typeof setInterval> | null = null;

  function hold(deviceId: string, category: "replies" | "notices") {
    const entry = held.get(deviceId) ?? { replies: 0, notices: 0 };
    entry[category] = Math.min(entry[category] + 1, 999);
    held.set(deviceId, entry);
    if (!heldTimer) {
      heldTimer = setInterval(() => {
        void dispatcher.flushHeld().catch((err: unknown) => {
          log.warn(`push summary failed: ${String(err)}`);
        });
      }, HELD_FLUSH_INTERVAL_MS);
      heldTimer.unref?.();
    }
  }

  function stopHeldTimer() {
    if (heldTimer && held.size === 0) {
      clearInterval(heldTimer);
      heldTimer = null;
    }
  }

  function allowRate(deviceId: string, limit: number, t: number): boolean {
    const times = (sentAt.get(deviceId) ?? []).filter((ts) => t - ts < HOUR_MS);
    if (limit >= 0 && times.length >= limit) {
      sentAt.set(deviceId, times);
      return false;
    }
    times.push(t);
    sentAt.set(deviceId, times);
    return true;
  }

  function hasReplyInterest(deviceId: string, sessionKey: string, t: number): boolean {
    const last = interest.get(deviceId)?.get(sessionKey);
    return last !== undefined && t - last < REPLY_INTEREST_MS;
  }

  async function deliver(
    sub: StoredPushSubscription,
    payload: PushPayload,
    cfg: BitterbotConfig,
  ): Promise<boolean> {
    const vapid = await getVapid();
    const subject = cfg.gateway?.mobile?.push?.subject?.trim() || DEFAULT_VAPID_SUBJECT;
    const body = sub.categories.previews ? payload : redactPreview(payload);
    const result = await send(sub, JSON.stringify(body), {
      vapid,
      subject,
      ttlSeconds: payload.kind === "approval" ? 15 * 60 : 60 * 60,
      urgency: payload.kind === "approval" ? "high" : "normal",
    });
    if (result.ok) {
      await recordOutcome(sub.deviceId, { ok: true });
      return true;
    }
    log.warn(
      `push to device ${sub.deviceId.slice(0, 12)} failed (${result.statusCode ?? "network"}): ${result.message}`,
    );
    await recordOutcome(sub.deviceId, { ok: false, gone: result.gone });
    return false;
  }

  const dispatcher = {
    /** A phone sent a chat message: it wants to hear when that session replies. */
    noteChatSend(deviceId: string, sessionKey: string) {
      const map = interest.get(deviceId) ?? new Map<string, number>();
      map.set(sessionKey, now());
      if (map.size > 50) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
          map.delete(oldest);
        }
      }
      interest.set(deviceId, map);
    },

    forgetDevice(deviceId: string) {
      interest.delete(deviceId);
      sentAt.delete(deviceId);
      held.delete(deviceId);
      stopHeldTimer();
    },

    /**
     * After quiet hours: one summary per phone of what was held back.
     * Rechecks the subscription, its categories and the pairing first, so a
     * phone removed or muted overnight gets nothing.
     */
    async flushHeld(): Promise<number> {
      if (held.size === 0) {
        stopHeldTimer();
        return 0;
      }
      const cfg = getConfig();
      const t = now();
      if (!pushEnabled(cfg)) {
        held.clear();
        stopHeldTimer();
        return 0;
      }
      if (isOwnerQuietHours(cfg, t)) {
        return 0;
      }
      const pending = new Map(held);
      held.clear();
      stopHeldTimer();
      const subs = await list();
      const limit = cfg.gateway?.mobile?.push?.maxPerHour ?? DEFAULT_PUSH_MAX_PER_HOUR;
      let sent = 0;
      for (const sub of subs) {
        const entry = pending.get(sub.deviceId);
        if (!entry) {
          continue;
        }
        const replies = sub.categories.replies ? entry.replies : 0;
        const notices = sub.categories.notices ? entry.notices : 0;
        if (replies + notices === 0 || isForeground(sub.deviceId)) {
          continue;
        }
        if (!(await isDeviceActive(sub.deviceId)) || !allowRate(sub.deviceId, limit, t)) {
          continue;
        }
        const parts = [
          replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "",
          notices ? `${notices} ${notices === 1 ? "notice" : "notices"}` : "",
        ].filter(Boolean);
        const payload: PushPayload = {
          kind: "summary",
          title: "While notifications were paused",
          body: parts.join(" and "),
          tag: "quiet-summary",
          url: replies ? "#/chat" : "#/status",
          ts: t,
        };
        if (await deliver(sub, payload, cfg)) {
          sent += 1;
        }
      }
      return sent;
    },

    /** Called for every broadcast. Never throws, never blocks the broadcast. */
    observe(event: string, payload: unknown): void {
      if (event !== "review.requested" && event !== "owner.notice" && event !== "chat") {
        return;
      }
      // Deltas stream many times a second; only a finished reply matters.
      if (event === "chat" && (payload as { state?: unknown } | null)?.state !== "final") {
        return;
      }
      void dispatcher.dispatch(event, payload).catch((err: unknown) => {
        log.warn(`push dispatch failed: ${String(err)}`);
      });
    },

    async dispatch(event: string, payload: unknown): Promise<number> {
      const t = now();
      const built = buildPushFromEvent(event, payload, t);
      if (!built) {
        return 0;
      }
      const cfg = getConfig();
      if (!pushEnabled(cfg)) {
        return 0;
      }
      const quiet = built.category !== "approvals" && isOwnerQuietHours(cfg, t);
      if (!quiet && held.size > 0) {
        await dispatcher.flushHeld();
      }
      const subs = await list();
      if (subs.length === 0) {
        return 0;
      }
      const limit = cfg.gateway?.mobile?.push?.maxPerHour ?? DEFAULT_PUSH_MAX_PER_HOUR;
      let sent = 0;
      for (const sub of subs) {
        if (!sub.categories[built.category]) {
          continue;
        }
        if (built.category === "replies") {
          if (!built.sessionKey || !hasReplyInterest(sub.deviceId, built.sessionKey, t)) {
            continue;
          }
        }
        if (isForeground(sub.deviceId)) {
          continue;
        }
        if (quiet) {
          hold(sub.deviceId, built.category === "replies" ? "replies" : "notices");
          continue;
        }
        if (!(await isDeviceActive(sub.deviceId))) {
          // Unpaired some other way (say, paired.json edited): never push, forget it.
          await recordOutcome(sub.deviceId, { ok: false, gone: true });
          continue;
        }
        if (!allowRate(sub.deviceId, limit, t)) {
          log.info(`push budget for device ${sub.deviceId.slice(0, 12)} used up this hour`);
          continue;
        }
        if (await deliver(sub, built.payload, cfg)) {
          sent += 1;
        }
      }
      return sent;
    },

    /** The Settings screen's "Send a test notification". */
    async sendTest(sub: StoredPushSubscription): Promise<boolean> {
      const cfg = getConfig();
      const t = now();
      if (
        !allowRate(
          sub.deviceId,
          cfg.gateway?.mobile?.push?.maxPerHour ?? DEFAULT_PUSH_MAX_PER_HOUR,
          t,
        )
      ) {
        return false;
      }
      return await deliver(
        sub,
        {
          kind: "test",
          title: "Bitterbot",
          body: "Notifications are working.",
          tag: "test",
          url: "#/settings",
          ts: t,
        },
        cfg,
      );
    },
  };
  return dispatcher;
}

export type PushDispatcher = ReturnType<typeof createPushDispatcher>;

let activeDispatcher: PushDispatcher | null = null;

export function setActivePushDispatcher(dispatcher: PushDispatcher | null) {
  activeDispatcher = dispatcher;
}

export function getActivePushDispatcher(): PushDispatcher | null {
  return activeDispatcher;
}
