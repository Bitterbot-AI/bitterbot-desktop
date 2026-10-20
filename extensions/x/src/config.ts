import type { BitterbotConfig } from "bitterbot/plugin-sdk";
import type { XAccountConfig, XPolicyConfig } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Conservative defaults. These sit far below X's technical ceilings on purpose:
 * X's automation rules punish volume and unsolicited engagement, and every
 * post is billed. The agent is always allowed to say nothing.
 */
export const DEFAULT_POLICY: XPolicyConfig = {
  maxPostsPerDay: 4,
  minIntervalMinutes: 90,
  allowLinks: false,
  allowMentions: false,
  allowReplies: false,
  dedupeWindowDays: 30,
  dedupeSimilarity: 0.7,
};

const ACCOUNT_KEYS = [
  "clientId",
  "clientSecret",
  "handle",
  "tokenFile",
  "callbackPort",
  "enabled",
  "policy",
] as const;

function pickAccountFields(raw: Record<string, unknown> | undefined): Partial<XAccountConfig> {
  const out: Record<string, unknown> = {};
  if (!raw) {
    return out;
  }
  for (const key of ACCOUNT_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = raw[key];
    }
  }
  return out as Partial<XAccountConfig>;
}

function readXRaw(coreConfig: unknown): Record<string, unknown> | undefined {
  if (!coreConfig || typeof coreConfig !== "object") {
    return undefined;
  }
  const channels = (coreConfig as BitterbotConfig).channels as Record<string, unknown> | undefined;
  const x = channels?.x;
  return x && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
}

/**
 * Resolve an account config. Base-level fields form the implicit "default"
 * account and take precedence over accounts.default (same rule as twitch).
 */
export function getAccountConfig(coreConfig: unknown, accountId: string): XAccountConfig | null {
  const raw = readXRaw(coreConfig);
  if (!raw) {
    return null;
  }
  const accounts = raw.accounts as Record<string, Record<string, unknown>> | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const merged = {
      ...pickAccountFields(accounts?.[DEFAULT_ACCOUNT_ID]),
      ...pickAccountFields(raw),
    };
    if (typeof merged.clientId === "string" && merged.clientId.length > 0) {
      // Channel-level `enabled: false` is the kill switch for every account.
      if (raw.enabled === false) {
        merged.enabled = false;
      }
      return merged as XAccountConfig;
    }
    return null;
  }
  const entry = accounts?.[accountId];
  if (!entry || typeof entry.clientId !== "string") {
    return null;
  }
  const picked = pickAccountFields(entry) as XAccountConfig;
  if (raw.enabled === false) {
    picked.enabled = false;
  }
  return picked;
}

export function listAccountIds(cfg: BitterbotConfig): string[] {
  const raw = readXRaw(cfg);
  const ids: string[] = [];
  const accounts = raw?.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    ids.push(...Object.keys(accounts));
  }
  if (raw && typeof raw.clientId === "string" && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}

export function resolvePolicy(account: XAccountConfig | null | undefined): XPolicyConfig {
  return { ...DEFAULT_POLICY, ...(account?.policy ?? {}) };
}

export function normalizeHandle(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^@/, "");
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function isAccountConfigured(account: XAccountConfig | null | undefined): boolean {
  return Boolean(account?.clientId && account.clientId.trim().length > 0);
}
