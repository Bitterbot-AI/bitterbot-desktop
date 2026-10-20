import type { BitterbotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
  type OutboundTargetResolution,
} from "../infra/outbound/targets.js";
import type { DeliverableMessageChannel } from "../utils/message-channel.js";
import type { CronDelivery } from "./types.js";

/**
 * What an isolated cron run does with its reply. Decided BEFORE the agent
 * turn, so a job that cannot deliver fails without paying for a model call.
 *
 * - `deliver`: send to a channel target, then post a short summary to the
 *   main session.
 * - `main-only`: no usable channel target. The reply stays in the job's own
 *   session and a summary goes to the main session.
 * - `none`: `delivery.mode = "none"`, nothing is posted anywhere.
 */
export type AnnouncePlan =
  | {
      kind: "deliver";
      channel: DeliverableMessageChannel;
      to: string;
      accountId?: string;
      threadId?: string | number;
    }
  | { kind: "main-only"; reason: string }
  | { kind: "none" };

export const NO_ANNOUNCE_TARGET = "announce delivery has no usable target";

type TargetCheck = (params: {
  channel: DeliverableMessageChannel;
  to: string;
  cfg?: BitterbotConfig;
  accountId?: string;
  /** The target came from the last route, not from the job. */
  fromLastRoute: boolean;
}) => OutboundTargetResolution;

/**
 * The same check heartbeat delivery runs: the channel must be loaded and
 * configured, and a target taken from the last route must still be allowed
 * by the channel's allowlist.
 */
const checkWithChannel: TargetCheck = (params) =>
  resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    mode: params.fromLastRoute ? "heartbeat" : "explicit",
  });

/**
 * Resolve the delivery plan for an isolated job.
 *
 * - A job that names `delivery.to` must name `delivery.channel` too, and is
 *   sent exactly there: nothing is borrowed from the last route.
 * - A job without `delivery.to` falls back to the main session's last route
 *   (optionally narrowed to `delivery.channel`), with that route's account
 *   and thread, as the cron docs describe.
 * - Either way the target is checked with the channel before the turn.
 *
 * With no usable target, a job that asked for `announce` explicitly fails
 * here (unless it is best-effort), and a job with no `delivery` block (the
 * default, and what the Control UI creates) keeps its result in the main
 * session instead of failing every run.
 */
export function resolveAnnouncePlan(params: {
  delivery?: CronDelivery;
  /** The agent's main session entry, for the last route. */
  mainEntry?: SessionEntry;
  cfg?: BitterbotConfig;
  /** Test seam; defaults to the channel's own target check. */
  checkTarget?: TargetCheck;
}): AnnouncePlan {
  const { delivery } = params;
  if (delivery?.mode === "none") {
    return { kind: "none" };
  }
  const check = params.checkTarget ?? checkWithChannel;
  const requested = delivery?.channel?.trim();
  const explicitChannel = requested && requested !== "last" ? requested : undefined;
  const explicitTo = delivery?.to?.trim() || undefined;

  let missing = "no delivery target and no last route";
  let plan: Extract<AnnouncePlan, { kind: "deliver" }> | undefined;

  if (explicitTo && !explicitChannel) {
    missing = "delivery.to needs delivery.channel";
  } else {
    const target = resolveSessionDeliveryTarget({
      entry: explicitTo ? undefined : params.mainEntry,
      requestedChannel: (explicitChannel ?? "last") as Parameters<
        typeof resolveSessionDeliveryTarget
      >[0]["requestedChannel"],
      explicitTo,
    });
    if (target.channel && target.to) {
      const fromLastRoute = !explicitTo;
      const checked = check({
        channel: target.channel,
        to: target.to,
        cfg: params.cfg,
        accountId: target.accountId,
        fromLastRoute,
      });
      if (checked.ok) {
        plan = {
          kind: "deliver",
          channel: target.channel,
          to: checked.to,
          ...(target.accountId ? { accountId: target.accountId } : {}),
          ...(target.threadId != null ? { threadId: target.threadId } : {}),
        };
      } else {
        missing = `${target.channel}:${target.to} is not deliverable (${checked.error.message})`;
      }
    } else if (explicitChannel) {
      missing = `no target for channel ${explicitChannel}`;
    }
  }

  if (plan) {
    return plan;
  }
  if (!delivery || delivery.bestEffort) {
    return { kind: "main-only", reason: missing };
  }
  throw new Error(`${NO_ANNOUNCE_TARGET}: ${missing}`);
}
