/**
 * The X policy gate. Pure function over (candidate, history, policy): every
 * outbound post passes through here before any network call. Rejections are
 * returned as human-readable reasons so the agent can see why in the tool result.
 *
 * Hard rules that are NOT configurable (X automation rules, April 2026):
 * - no automated likes / follows / retweets (not implemented at all)
 * - replies off unless the operator flips allowReplies (X requires prior
 *   written approval for AI reply bots)
 * - never post while the kill switch file exists
 */

import type { XLedgerEntry, XPolicyConfig, XPolicyVerdict } from "./types.js";
import {
  X_MAX_WEIGHTED_LENGTH,
  findLinks,
  findMentions,
  similarity,
  weightedLength,
} from "./text.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PolicyInput = {
  text: string;
  replyToId?: string | null;
  policy: XPolicyConfig;
  /** Ledger entries inside the dedupe window (newest or oldest order, either works). */
  history: XLedgerEntry[];
  /** Bot's own handle (lowercase, no @); self-mentions are always allowed. */
  selfHandle?: string;
  now?: number;
};

export function evaluatePolicy(input: PolicyInput): XPolicyVerdict {
  const now = input.now ?? Date.now();
  const text = input.text ?? "";
  const trimmed = text.trim();
  const { policy } = input;

  if (!trimmed) {
    return { ok: false, reason: "empty post" };
  }
  const length = weightedLength(trimmed);
  if (length > X_MAX_WEIGHTED_LENGTH) {
    return {
      ok: false,
      reason: `post is ${length} weighted characters; X limit is ${X_MAX_WEIGHTED_LENGTH}. Shorten it; this channel never auto-threads.`,
    };
  }

  if (input.replyToId && !policy.allowReplies) {
    return {
      ok: false,
      reason:
        "replies are disabled (policy.allowReplies=false). X requires prior written approval for AI-powered reply bots.",
    };
  }

  if (!policy.allowLinks) {
    const links = findLinks(trimmed);
    if (links.length > 0) {
      return {
        ok: false,
        reason: `links are disabled (policy.allowLinks=false): ${links.join(", ")}. X bills link posts at 13x and link-heavy automated accounts read as spam.`,
      };
    }
  }

  if (!policy.allowMentions) {
    const mentions = findMentions(trimmed).filter((m) => m !== input.selfHandle);
    if (mentions.length > 0) {
      return {
        ok: false,
        reason: `unsolicited @mentions are disabled (policy.allowMentions=false): @${mentions.join(", @")}`,
      };
    }
  }

  const lastDay = input.history.filter((e) => e.ts > now - DAY_MS);
  if (lastDay.length >= policy.maxPostsPerDay) {
    const oldest = Math.min(...lastDay.map((e) => e.ts));
    const minutesUntil = Math.ceil((oldest + DAY_MS - now) / 60000);
    return {
      ok: false,
      reason: `daily cap reached (${lastDay.length}/${policy.maxPostsPerDay} in the last 24h); next slot in ~${minutesUntil} min`,
    };
  }

  if (policy.minIntervalMinutes > 0) {
    const latest = input.history.reduce((max, e) => Math.max(max, e.ts), 0);
    const sinceMin = (now - latest) / 60000;
    if (latest > 0 && sinceMin < policy.minIntervalMinutes) {
      return {
        ok: false,
        reason: `last post was ${Math.floor(sinceMin)} min ago; minimum interval is ${policy.minIntervalMinutes} min`,
      };
    }
  }

  for (const entry of input.history) {
    const score = similarity(trimmed, entry.text);
    if (score >= policy.dedupeSimilarity) {
      return {
        ok: false,
        reason: `too similar (${score.toFixed(2)}) to a post from ${new Date(entry.ts).toISOString()}: "${entry.text.slice(0, 60)}"`,
      };
    }
  }

  return { ok: true, weightedLength: length };
}
