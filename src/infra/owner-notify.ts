/**
 * Telling the owner something happened while they were not looking
 * (PLAN-53 E3, E9): a scheduled job that failed, a job that was turned off, a
 * task left stranded by a restart.
 *
 * Every notice lands in the main session, so the agent and the Control UI
 * always have it. It is also pushed to a chat channel when there is one to
 * push to, it is not quiet hours, and the hourly allowance is not used up.
 * The point of this module is that none of those conditions can make a
 * notice disappear: the worst case is that it waits in the session.
 */

import { loadConfig } from "../config/config.js";
import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("owner-notify");

export type OwnerNotice = {
  /** What happened, in a sentence or two the owner can act on. */
  text: string;
  /** A short machine label: "cron-error", "cron-disabled", "task-stalled". */
  kind: string;
  /** Notices with the same key inside the dedupe window are sent once. */
  dedupeKey?: string;
};

export type OwnerNoticeResult = {
  /** Where it went beyond the main session. */
  pushed: "channel" | "none";
  /** Why it was not pushed, when it was not. */
  reason?: "no-target" | "quiet-hours" | "rate-limited" | "duplicate" | "send-failed";
};

export type OwnerNotifyDeps = {
  cfg: BitterbotConfig;
  now: () => number;
  /** Put the notice in front of the main session's next turn. */
  toSession: (text: string, contextKey: string) => void;
  /** Tell every open Control UI window. */
  toUi: (payload: { kind: string; text: string; ts: number }) => void;
  /** Where a push should go, or null when there is nowhere. */
  resolveTarget: (cfg: BitterbotConfig) => Promise<PushTarget | null> | PushTarget | null;
  send: (target: PushTarget, text: string) => Promise<void>;
  inQuietHours: (cfg: BitterbotConfig, now: number) => boolean;
};

export type PushTarget = { channel: string; to: string; accountId?: string };

export const DEFAULT_OWNER_NOTICES_PER_HOUR = 6;
const DEDUPE_WINDOW_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Send times inside the last hour, and when each dedupe key was last used. */
const sentAt: number[] = [];
const lastByKey = new Map<string, number>();

let uiBroadcast: ((payload: { kind: string; text: string; ts: number }) => void) | null = null;

/** The gateway installs its broadcaster once the WS server is up. */
export function setOwnerNoticeBroadcast(fn: typeof uiBroadcast): void {
  uiBroadcast = fn;
}

export async function notifyOwner(
  notice: OwnerNotice,
  overrides: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerNoticeResult> {
  const deps = { ...(await defaultDeps(overrides.cfg)), ...overrides };
  const now = deps.now();
  const text = notice.text.trim();
  if (!text) {
    return { pushed: "none", reason: "duplicate" };
  }

  if (notice.dedupeKey) {
    const last = lastByKey.get(notice.dedupeKey);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return { pushed: "none", reason: "duplicate" };
    }
    lastByKey.set(notice.dedupeKey, now);
    if (lastByKey.size > 500) {
      const oldest = lastByKey.keys().next().value;
      if (oldest !== undefined) {
        lastByKey.delete(oldest);
      }
    }
  }

  // The floor: these two always happen.
  try {
    deps.toSession(`[notice] ${text}`, `owner-notice:${notice.dedupeKey ?? notice.kind}`);
  } catch (err) {
    log.warn(`could not queue a notice for the main session: ${String(err)}`);
  }
  try {
    deps.toUi({ kind: notice.kind, text, ts: now });
  } catch {
    // Nobody is watching; the session copy stands.
  }

  if (deps.inQuietHours(deps.cfg, now)) {
    return { pushed: "none", reason: "quiet-hours" };
  }
  while (sentAt.length > 0 && now - sentAt[0] >= HOUR_MS) {
    sentAt.shift();
  }
  const limit = deps.cfg.notifications?.maxPerHour ?? DEFAULT_OWNER_NOTICES_PER_HOUR;
  if (limit >= 0 && sentAt.length >= limit) {
    return { pushed: "none", reason: "rate-limited" };
  }
  const target = await deps.resolveTarget(deps.cfg);
  if (!target) {
    return { pushed: "none", reason: "no-target" };
  }
  try {
    await deps.send(target, text);
    sentAt.push(now);
    return { pushed: "channel" };
  } catch (err) {
    log.warn(`could not push a notice to ${target.channel}: ${String(err)}`);
    return { pushed: "none", reason: "send-failed" };
  }
}

async function defaultDeps(cfgOverride?: BitterbotConfig): Promise<OwnerNotifyDeps> {
  const cfg = cfgOverride ?? loadConfig();
  return {
    cfg,
    now: Date.now,
    toSession: (text, contextKey) => {
      void (async () => {
        const { resolveMainSessionKey } = await import("../config/sessions.js");
        const { enqueueSystemEvent } = await import("./system-events.js");
        enqueueSystemEvent(text, { sessionKey: resolveMainSessionKey(cfg), contextKey });
      })().catch((err) => log.warn(`session notice failed: ${String(err)}`));
    },
    toUi: (payload) => uiBroadcast?.(payload),
    resolveTarget: resolveOwnerPushTarget,
    send: async (target, text) => {
      const { deliverOutboundPayloads } = await import("./outbound/deliver.js");
      await deliverOutboundPayloads({
        cfg,
        channel: target.channel as never,
        to: target.to,
        accountId: target.accountId,
        payloads: [{ text }],
        bestEffort: true,
      });
    },
    inQuietHours: isOwnerQuietHours,
  };
}

/**
 * `notifications.owner` when it is set; otherwise wherever the heartbeat would
 * deliver (its configured target, or the main session's last conversation).
 */
export async function resolveOwnerPushTarget(cfg: BitterbotConfig): Promise<PushTarget | null> {
  const explicit = cfg.notifications?.owner;
  if (explicit?.channel?.trim() && explicit.to?.trim()) {
    return {
      channel: explicit.channel.trim().toLowerCase(),
      to: explicit.to.trim(),
      accountId: explicit.accountId?.trim() || undefined,
    };
  }
  try {
    const { resolveDefaultAgentId } = await import("../agents/agent-scope.js");
    const { peekSessionStore, resolveMainSessionKey, resolveStorePath } =
      await import("../config/sessions.js");
    const { resolveHeartbeatDeliveryTarget } = await import("./outbound/targets.js");
    const store = peekSessionStore(
      resolveStorePath(cfg.session?.store, { agentId: resolveDefaultAgentId(cfg) }),
    );
    const target = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: store[resolveMainSessionKey(cfg)],
    });
    if (target.channel === "none" || !target.to) {
      return null;
    }
    return { channel: target.channel, to: target.to, accountId: target.accountId };
  } catch (err) {
    log.debug(`no push target: ${String(err)}`);
    return null;
  }
}

function minutesOfDay(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 24 || minutes > 59 ? null : hours * 60 + minutes;
}

/** True inside `notifications.quietHours` (which may run past midnight). */
export function isOwnerQuietHours(cfg: BitterbotConfig, nowMs: number): boolean {
  const quiet = cfg.notifications?.quietHours;
  const start = minutesOfDay(quiet?.start);
  const end = minutesOfDay(quiet?.end);
  if (start === null || end === null || start === end) {
    return false;
  }
  let current: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: quiet?.timezone?.trim() || undefined,
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    current = hour * 60 + minute;
  } catch {
    // An unknown timezone must not silence notices.
    return false;
  }
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function resetOwnerNotifyForTest(): void {
  sentAt.length = 0;
  lastByKey.clear();
  uiBroadcast = null;
}
