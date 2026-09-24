/**
 * X channel plugin types.
 *
 * Generic channel types come from the plugin SDK; only X-specific shapes live here.
 */

import type {
  BitterbotConfig,
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelPlugin,
  ChannelStatusAdapter,
} from "bitterbot/plugin-sdk";
import type { OutboundDeliveryResult } from "../../../src/infra/outbound/deliver.js";

/** Posting policy. Every field has a conservative default; see config.ts. */
export interface XPolicyConfig {
  /** Hard cap on posts (originals + replies) per rolling 24h. Default 4. */
  maxPostsPerDay: number;
  /** Minimum minutes between two posts. Default 90. */
  minIntervalMinutes: number;
  /** Allow http(s) links / bare domains in posts. Default false (X bills link posts 13x). */
  allowLinks: boolean;
  /** Allow @mentions of accounts other than the bot itself. Default false. */
  allowMentions: boolean;
  /** Allow replies (`reply:<postId>` targets). Default false: X requires written approval for AI reply bots. */
  allowReplies: boolean;
  /** Days of ledger history consulted for duplicate detection. Default 30. */
  dedupeWindowDays: number;
  /** Trigram-Jaccard similarity at or above which a candidate counts as a duplicate. Default 0.7. */
  dedupeSimilarity: number;
}

/** Account configuration for an X account (merged base-level + accounts.<id>). */
export interface XAccountConfig {
  /** OAuth 2.0 client id of the X developer app (public). Required. */
  clientId: string;
  /** OAuth 2.0 client secret (confidential clients only; "Automated App / Bot" type). */
  clientSecret?: string;
  /** Expected @handle of the bot account (without @). Used to allow self-mentions and sanity-check login. */
  handle?: string;
  /** Override for the OAuth token file path. Default: <stateDir>/x/<accountId>.token.json */
  tokenFile?: string;
  /** Local callback port used by `bitterbot x login`. Default 19010. */
  callbackPort?: number;
  /** Enable this account. Default true once configured. */
  enabled?: boolean;
  /** Posting policy overrides. */
  policy?: Partial<XPolicyConfig>;
}

/** Persisted OAuth token bundle (token file contents). */
export interface XTokenRecord {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  scope?: string;
  /** X user id of the authorized account. */
  userId?: string;
  /** X username (handle without @) of the authorized account. */
  username?: string;
  obtainedAt: number;
}

/** One line of the posts ledger. */
export interface XLedgerEntry {
  ts: number;
  id: string;
  kind: "post" | "reply";
  text: string;
  replyToId?: string;
  url?: string;
  accountId: string;
}

export type XPostTarget = { kind: "timeline" } | { kind: "reply"; postId: string };

export type XPolicyVerdict = { ok: true; weightedLength: number } | { ok: false; reason: string };

export type {
  BitterbotConfig,
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelPlugin,
  ChannelStatusAdapter,
  OutboundDeliveryResult,
};
