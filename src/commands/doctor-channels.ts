/**
 * Top-level Channels doctor section.
 *
 * Channels are the inbound/outbound messaging surfaces the agent talks
 * through — WhatsApp, Telegram, Discord, Slack, Signal, iMessage. The
 * gateway exposes a runtime `channels.status` RPC but that only tells
 * us anything if the gateway is running. This section runs a static,
 * offline pass over the config so operators see issues before the first
 * start — especially the ones that cause silent failure (enabled
 * channel without credentials) or attack-surface creep (configWrites
 * on, DM policy = open).
 *
 * What we check per enabled channel:
 *   1. At least one credential field is set (token / bot token / phone)
 *   2. DM policy is sensible (warn on `open` without tight allowFrom)
 *   3. `configWrites` is off (prompt-injection-writing-to-disk is a
 *      known hazard; flag ON explicitly)
 *
 * What we deliberately don't check:
 *   - Credential validity (requires live API calls — doctor never
 *     spends gas, tokens, or rate-limit budget)
 *   - Per-group / per-DM allowlist membership (too noisy; the gateway's
 *     runtime status check is better for that)
 */

import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `\u2714 ${r.message}`;
    case "warn":
      return `\u26A0 ${r.message}`;
    case "error":
      return `\u2718 ${r.message}`;
    case "info":
      return `\u2139 ${r.message}`;
    default:
      return r.message;
  }
}

// Per-channel credential fields. A channel is "has creds" if any of these
// is a non-empty string. Env-var fallbacks are included because operators
// commonly keep tokens out of config.
const CHANNEL_CREDS: Record<
  string,
  { label: string; fields: readonly string[]; envVars: readonly string[] }
> = {
  whatsapp: {
    label: "WhatsApp",
    fields: ["phone", "account", "sessionName"],
    envVars: ["WHATSAPP_PHONE", "WA_PHONE"],
  },
  telegram: {
    label: "Telegram",
    fields: ["botToken", "tokenFile", "webhookUrl"],
    envVars: ["TELEGRAM_BOT_TOKEN"],
  },
  discord: {
    label: "Discord",
    fields: ["token"],
    envVars: ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"],
  },
  slack: {
    label: "Slack",
    fields: ["botToken", "appToken", "signingSecret"],
    envVars: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
  signal: {
    label: "Signal",
    fields: ["phone", "username"],
    envVars: ["SIGNAL_PHONE"],
  },
  imessage: {
    label: "iMessage",
    fields: ["dbPath", "account"],
    envVars: [],
  },
  bluebubbles: {
    label: "BlueBubbles",
    fields: ["serverUrl", "password"],
    envVars: ["BLUEBUBBLES_SERVER_URL"],
  },
};

type AnyChannel = {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: unknown[];
  configWrites?: boolean;
} & Record<string, unknown>;

function hasCred(channel: AnyChannel, channelKey: string): boolean {
  const meta = CHANNEL_CREDS[channelKey];
  if (!meta) {
    return true; // unknown extension channel — we don't know its cred shape, trust the user
  }
  for (const field of meta.fields) {
    const v = channel[field];
    if (typeof v === "string" && v.trim().length > 0) {
      return true;
    }
  }
  for (const envVar of meta.envVars) {
    if (process.env[envVar]?.trim()) {
      return true;
    }
  }
  return false;
}

export function runChannelsChecks(params: { config: BitterbotConfig }): void {
  const { config } = params;
  const channels = config.channels as Record<string, AnyChannel> | undefined;
  const results: CheckResult[] = [];

  if (!channels) {
    results.push(info("No channels configured — agent has no messaging surfaces."));
    renderSection(results);
    return;
  }

  let enabledCount = 0;
  const knownKeys = Object.keys(CHANNEL_CREDS);
  // Also surface extension channels (nostr, matrix, zalo, etc.) that passthrough
  const extraKeys = Object.keys(channels).filter((k) => k !== "defaults" && !knownKeys.includes(k));

  for (const key of [...knownKeys, ...extraKeys]) {
    const channel = channels[key];
    if (!channel || channel.enabled !== true) {
      continue;
    }
    enabledCount += 1;
    const label = CHANNEL_CREDS[key]?.label ?? key;

    // ── Credentials ──
    if (!hasCred(channel, key)) {
      const envHint = CHANNEL_CREDS[key]?.envVars.length
        ? ` (or export ${CHANNEL_CREDS[key].envVars.join(" / ")})`
        : "";
      results.push(
        warn(
          `${label}: enabled but no credentials found in config${envHint}. ` +
            `Runtime will fail to connect — set the token / phone / signing secret.`,
        ),
      );
    } else {
      results.push(ok(`${label}: enabled, credentials present`));
    }

    // ── DM policy ──
    const dmPolicy = channel.dmPolicy;
    const allowFrom = Array.isArray(channel.allowFrom) ? channel.allowFrom : [];
    if (dmPolicy === "open") {
      const wildcardOnly =
        allowFrom.length > 0 && allowFrom.every((e) => typeof e === "string" && e === "*");
      if (wildcardOnly) {
        results.push(
          warn(
            `${label}: dmPolicy=open with allowFrom=["*"] — ANY inbound DM can drive the agent. ` +
              `Switch to pairing or allowlist unless this is a public demo.`,
          ),
        );
      }
    } else if (dmPolicy === "allowlist" && allowFrom.length === 0) {
      results.push(
        warn(
          `${label}: dmPolicy=allowlist but allowFrom is empty — nobody can DM the agent. ` +
            `Add senders to allowFrom or switch to pairing.`,
        ),
      );
    }

    // ── configWrites hazard ──
    if (channel.configWrites === true) {
      results.push(
        warn(
          `${label}: configWrites=true — the agent can modify its own config from this channel. ` +
            `This is a prompt-injection attack surface; keep off unless you know why you need it.`,
        ),
      );
    }
  }

  if (enabledCount === 0) {
    results.push(
      info(
        "No channels enabled. Agent has no inbound surfaces — enable one with " +
          formatCliCommand("bitterbot configure --section channels") +
          ".",
      ),
    );
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Channels");
}
