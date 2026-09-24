/**
 * X (Twitter) channel plugin for Bitterbot.
 *
 * Outbound-only: original posts (and replies, off by default) through the
 * official X API v2. No gateway adapter: nothing listens, polls, likes,
 * follows or reads timelines. Every post passes the policy gate in policy.ts.
 */

import type { BitterbotConfig } from "bitterbot/plugin-sdk";
import { buildChannelConfigSchema } from "bitterbot/plugin-sdk";
import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelPlugin,
  XAccountConfig,
} from "./types.js";
import { XConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  isAccountConfigured,
  listAccountIds,
  resolvePolicy,
} from "./config.js";
import { parseXTarget, X_TARGET_HINT, xOutbound } from "./outbound.js";
import { collectXStatusIssues, probeX } from "./status.js";
import { X_MAX_WEIGHTED_LENGTH } from "./text.js";

function resolveAccountId(cfg: BitterbotConfig, account: XAccountConfig): string {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.x as
    | Record<string, unknown>
    | undefined;
  const accounts = (raw?.accounts as Record<string, unknown> | undefined) ?? {};
  return Object.entries(accounts).find(([, value]) => value === account)?.[0] ?? DEFAULT_ACCOUNT_ID;
}

export const xPlugin: ChannelPlugin<XAccountConfig> = {
  id: "x",

  meta: {
    id: "x",
    label: "X",
    selectionLabel: "X (Twitter, posts only)",
    docsPath: "/channels/x",
    blurb: "Policy-gated original posts to an X account via the official API",
    aliases: ["twitter", "x-twitter"],
  } satisfies ChannelMeta,

  capabilities: {
    chatTypes: ["direct"],
  } satisfies ChannelCapabilities,

  reload: { configPrefixes: ["channels.x"] },

  configSchema: buildChannelConfigSchema(XConfigSchema),

  config: {
    listAccountIds: (cfg: BitterbotConfig): string[] => listAccountIds(cfg),
    resolveAccount: (cfg: BitterbotConfig, accountId?: string | null): XAccountConfig => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      return account ?? ({ clientId: "", enabled: false } as XAccountConfig);
    },
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: XAccountConfig | undefined): boolean => isAccountConfigured(account),
    isEnabled: (account: XAccountConfig | undefined): boolean => account?.enabled !== false,
    describeAccount: (account: XAccountConfig | undefined, cfg: BitterbotConfig) => ({
      accountId: account ? resolveAccountId(cfg, account) : DEFAULT_ACCOUNT_ID,
      enabled: account?.enabled !== false,
      configured: isAccountConfigured(account),
    }),
  },

  outbound: xOutbound,

  messaging: {
    // "timeline" / "reply:<id>" are ids, not names to look up in a directory.
    normalizeTarget: (raw: string) => {
      const target = parseXTarget(raw);
      if (!target) {
        return undefined;
      }
      return target.kind === "reply" ? `reply:${target.postId}` : "timeline";
    },
    targetResolver: {
      looksLikeId: (raw: string) => parseXTarget(raw) !== null,
      hint: X_TARGET_HINT,
    },
  },

  agentPrompt: {
    messageToolHints: ({ cfg, accountId }) => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      const policy = resolvePolicy(account);
      return [
        `X: ${X_TARGET_HINT}.`,
        `X posts are public and permanent-ish; max ${X_MAX_WEIGHTED_LENGTH} weighted chars, no threads.`,
        `X policy: at most ${policy.maxPostsPerDay} posts/day, ${policy.minIntervalMinutes} min apart, links ${policy.allowLinks ? "allowed" : "blocked"}, @mentions ${policy.allowMentions ? "allowed" : "blocked"}, replies ${policy.allowReplies ? "allowed" : "blocked"}, near-duplicates blocked.`,
        "X: saying nothing is always acceptable. Only post when you genuinely have something worth saying.",
      ];
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }: { snapshot: ChannelAccountSnapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, cfg }: { account: XAccountConfig; cfg: BitterbotConfig }) =>
      probeX(account, resolveAccountId(cfg, account)),
    buildAccountSnapshot: ({
      account,
      cfg,
      runtime,
      probe,
    }: {
      account: XAccountConfig;
      cfg: BitterbotConfig;
      runtime?: ChannelAccountSnapshot;
      probe?: unknown;
    }): ChannelAccountSnapshot => ({
      accountId: resolveAccountId(cfg, account),
      enabled: account?.enabled !== false,
      configured: isAccountConfigured(account),
      // Outbound-only channel: "running" means "authorized", nothing is connected.
      running: Boolean((probe as { authorized?: boolean } | undefined)?.authorized),
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
    resolveAccountState: ({ configured, enabled }) =>
      !configured ? "not configured" : !enabled ? "disabled" : "linked",
    collectStatusIssues: collectXStatusIssues,
  },
};
