import type { ChannelStatusIssue } from "bitterbot/plugin-sdk";
import type { ChannelAccountSnapshot, XAccountConfig, XTokenRecord } from "./types.js";
import { resolveTokenFilePath } from "./paths.js";
import { readTokenRecord } from "./token-store.js";

/**
 * Offline probe: reports token presence/expiry from the token file only.
 * It deliberately makes no X API call because every read is billed.
 */
export type XProbe = {
  ok: boolean;
  authorized: boolean;
  username?: string;
  userId?: string;
  expiresAt?: number;
  hasRefreshToken: boolean;
  tokenFile: string;
  error?: string;
};

export async function probeX(account: XAccountConfig, accountId: string): Promise<XProbe> {
  const tokenFile = resolveTokenFilePath({ accountId, override: account.tokenFile });
  let record: XTokenRecord | null = null;
  try {
    record = await readTokenRecord(tokenFile);
  } catch (err) {
    return {
      ok: false,
      authorized: false,
      hasRefreshToken: false,
      tokenFile,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!record) {
    return {
      ok: false,
      authorized: false,
      hasRefreshToken: false,
      tokenFile,
      error: "not authorized",
    };
  }
  return {
    ok: true,
    authorized: true,
    username: record.username,
    userId: record.userId,
    expiresAt: record.expiresAt,
    hasRefreshToken: Boolean(record.refreshToken),
    tokenFile,
  };
}

export function collectXStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const accountId = entry.accountId;
    if (!accountId) {
      continue;
    }
    if (!entry.configured) {
      issues.push({
        channel: "x",
        accountId,
        kind: "config",
        message: "X account is not configured",
        fix: "Set channels.x.clientId (and clientSecret for a confidential app), then run `bitterbot x login`.",
      });
      continue;
    }
    if (entry.enabled === false) {
      issues.push({
        channel: "x",
        accountId,
        kind: "config",
        message: "X channel is disabled",
        fix: "Set channels.x.enabled: true to allow posting.",
      });
      continue;
    }
    const probe = entry.probe as XProbe | undefined;
    if (probe && !probe.authorized) {
      issues.push({
        channel: "x",
        accountId,
        kind: "auth",
        message: `X account is not authorized (${probe.error ?? "no token"})`,
        fix: "Run `bitterbot x login` and approve the app in the browser.",
      });
    } else if (probe && !probe.hasRefreshToken) {
      issues.push({
        channel: "x",
        accountId,
        kind: "auth",
        message: "X token has no refresh token; posting will stop when it expires (~2h)",
        fix: "Re-run `bitterbot x login`; the offline.access scope is requested automatically.",
      });
    }
    if (entry.lastError) {
      issues.push({
        channel: "x",
        accountId,
        kind: "runtime",
        message: `Last error: ${entry.lastError}`,
      });
    }
  }
  return issues;
}
