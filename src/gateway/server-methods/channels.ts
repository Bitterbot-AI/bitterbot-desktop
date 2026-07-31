import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.js";
import type { BitterbotConfig } from "../../config/config.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsConfigureParams,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
  validateChannelsUpdateParams,
  validateChannelsValidateParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

export type ChannelCapabilityInfo = {
  /** False when the gateway host cannot run this channel at all. */
  supported: boolean;
  /** User-facing copy: why the channel is unavailable on this host. */
  reason?: string;
  /** Static platform requirement from the plugin meta, when declared. */
  platforms?: string[];
};

/**
 * Host capability check per channel: static meta.platforms first (checked
 * against the GATEWAY host's process.platform - remote Control UIs run on a
 * different OS than the gateway), then the plugin's availability() probe
 * (binaries like signal-cli). UIs render unsupported channels greyed with
 * the reason rather than hiding them.
 */
// Availability probes can spawn processes (e.g. `which signal-cli`);
// channels.status is read-scoped and may be polled, so cache briefly to
// keep it from becoming a process-spawn amplifier.
const AVAILABILITY_CACHE_TTL_MS = 60_000;
let availabilityCache: { at: number; value: Record<string, ChannelCapabilityInfo> } | null = null;

export function __resetChannelCapabilityCacheForTest(): void {
  availabilityCache = null;
}

export async function buildChannelCapabilities(params: {
  plugins: ChannelPlugin[];
  cfg: BitterbotConfig;
}): Promise<Record<string, ChannelCapabilityInfo>> {
  if (availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_CACHE_TTL_MS) {
    return availabilityCache.value;
  }
  const result: Record<string, ChannelCapabilityInfo> = {};
  for (const plugin of params.plugins) {
    const platforms = plugin.meta.platforms;
    let supported = true;
    let reason: string | undefined;
    if (platforms && !platforms.includes(process.platform as never)) {
      supported = false;
      reason = `Requires a ${platforms.join(" or ")} gateway host (this gateway runs on ${process.platform}).`;
    } else if (plugin.availability) {
      try {
        const availability = await plugin.availability({ cfg: params.cfg });
        supported = availability.available;
        reason = availability.reason;
      } catch (err) {
        supported = false;
        reason = `Availability check failed: ${formatForLog(err)}`;
      }
    }
    result[plugin.id] = {
      supported,
      ...(reason ? { reason } : {}),
      ...(platforms ? { platforms } : {}),
    };
  }
  availabilityCache = { at: Date.now(), value: result };
  return result;
}

/**
 * Sanitize a guided-setup draft: drop empty/sentinel values so redacted
 * placeholders round-tripped from the UI never overwrite stored secrets.
 * The returned object is what gets handed to plugin.setup.applyAccountConfig.
 */
export function sanitizeSetupInput(raw: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || trimmed === REDACTED_SENTINEL) {
        continue;
      }
      input[key] = trimmed;
      continue;
    }
    input[key] = value;
  }
  return input;
}

function resolveDefaultAccountIdForPlugin(plugin: ChannelPlugin, cfg: BitterbotConfig): string {
  return (
    plugin.config.defaultAccountId?.(cfg) ||
    plugin.config.listAccountIds(cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: BitterbotConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      const resolvedAccounts: Record<string, unknown> = {};
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = isAccountEnabled(plugin, account);
        resolvedAccounts[accountId] = account;
        let probeResult: unknown;
        let lastProbeAt: number | null = null;
        if (probe && enabled && plugin.status?.probeAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            probeResult = await plugin.status.probeAccount({
              account,
              timeoutMs,
              cfg,
            });
            lastProbeAt = Date.now();
          }
        }
        let auditResult: unknown;
        if (probe && enabled && plugin.status?.auditAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            auditResult = await plugin.status.auditAccount({
              account,
              timeoutMs,
              cfg,
              probe: probeResult,
            });
          }
        }
        const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
        const snapshot = await buildChannelAccountSnapshot({
          plugin,
          cfg,
          accountId,
          runtime: runtimeSnapshot,
          probe: probeResult,
          audit: auditResult,
        });
        if (lastProbeAt) {
          snapshot.lastProbeAt = lastProbeAt;
        }
        const activity = getChannelActivity({
          channel: channelId as never,
          accountId,
        });
        if (snapshot.lastInboundAt == null) {
          snapshot.lastInboundAt = activity.inboundAt;
        }
        if (snapshot.lastOutboundAt == null) {
          snapshot.lastOutboundAt = activity.outboundAt;
        }
        accounts.push(snapshot);
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(plugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channelCapabilities: await buildChannelCapabilities({ plugins, cfg }),
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    for (const plugin of plugins) {
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildChannelAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: fallbackAccount,
            cfg,
            defaultAccountId,
            snapshot:
              defaultAccount ??
              ({
                accountId: defaultAccountId,
              } as ChannelAccountSnapshot),
          })
        : {
            configured: defaultAccount?.configured ?? false,
          };
      channelsMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    respond(true, payload, undefined);
  },
  "channels.update": async ({ params, respond, context }) => {
    if (!validateChannelsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.update params: ${formatValidationErrors(validateChannelsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const channelId = normalizeChannelId(params.channel);
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.update channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.config.setAccountEnabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `channel ${channelId} does not support enable/disable`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before toggling channels"),
      );
      return;
    }
    const cfg = snapshot.config ?? {};
    const accountId =
      params.accountId?.trim() ||
      plugin.config.defaultAccountId?.(cfg) ||
      plugin.config.listAccountIds(cfg)[0] ||
      DEFAULT_ACCOUNT_ID;
    const enabled = params.enabled;
    try {
      const next = plugin.config.setAccountEnabled({ cfg, accountId, enabled });
      await writeConfigFile(next);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      return;
    }
    // Drive the lifecycle explicitly instead of relying on the config
    // watcher: some channels (WhatsApp) declare their config prefix as a
    // noop, so a config write alone would leave the runtime unchanged.
    let runtime = enabled ? "started" : "stopped";
    try {
      if (enabled) {
        await context.startChannel(channelId, accountId);
      } else {
        await context.stopChannel(channelId, accountId);
      }
    } catch (err) {
      // Config write succeeded; report the runtime hiccup honestly instead
      // of failing the toggle (the channel may simply not be configured yet).
      runtime = `error: ${formatForLog(err)}`;
    }
    respond(true, { ok: true, channel: channelId, accountId, enabled, runtime }, undefined);
  },
  "channels.validate": async ({ params, respond }) => {
    if (!validateChannelsValidateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.validate params: ${formatValidationErrors(validateChannelsValidateParams.errors)}`,
        ),
      );
      return;
    }
    const channelId = normalizeChannelId(params.channel);
    const plugin = channelId ? getChannelPlugin(channelId) : null;
    if (!plugin?.setup?.applyAccountConfig) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `channel ${params.channel} does not support guided setup`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const accountId = params.accountId?.trim() || resolveDefaultAccountIdForPlugin(plugin, cfg);
    const input = sanitizeSetupInput(params.input);
    // The dry-run probe must not become a file-read oracle: a draft
    // tokenFile would make the gateway read an arbitrary path and leak
    // existence/validity through differing probe errors. Path-based setup
    // goes through channels.configure (a real config write, same trust as
    // config.set).
    if (typeof input.tokenFile === "string") {
      respond(
        true,
        {
          result: {
            ok: false,
            error: "tokenFile cannot be validated as a draft; save it via Save & Enable instead.",
          },
          probed: false,
        },
        undefined,
      );
      return;
    }
    const validationError = plugin.setup.validateInput?.({ cfg, accountId, input });
    if (validationError) {
      respond(true, { result: { ok: false, error: validationError }, probed: false }, undefined);
      return;
    }
    try {
      // Draft config lives only in this handler; it is never written to disk
      // and the draft secrets are never logged.
      const draftCfg = plugin.setup.applyAccountConfig({ cfg, accountId, input });
      const account = plugin.config.resolveAccount(draftCfg, accountId);
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, draftCfg)
        : true;
      if (!configured) {
        respond(
          true,
          {
            result: {
              ok: false,
              error:
                plugin.config.unconfiguredReason?.(account, draftCfg) ??
                "Required fields are still missing.",
            },
            probed: false,
          },
          undefined,
        );
        return;
      }
      if (!plugin.status?.probeAccount) {
        respond(
          true,
          {
            result: { ok: true },
            probed: false,
            note: "This channel has no live probe; fields look complete.",
          },
          undefined,
        );
        return;
      }
      const timeoutMs = params.timeoutMs ?? 10_000;
      const probe = await plugin.status.probeAccount({ account, timeoutMs, cfg: draftCfg });
      respond(true, { result: probe, probed: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "channels.configure": async ({ params, respond, context }) => {
    if (!validateChannelsConfigureParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.configure params: ${formatValidationErrors(validateChannelsConfigureParams.errors)}`,
        ),
      );
      return;
    }
    const channelId = normalizeChannelId(params.channel);
    const plugin = channelId ? getChannelPlugin(channelId) : null;
    if (!plugin?.setup?.applyAccountConfig || !channelId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `channel ${params.channel} does not support guided setup`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before configuring"),
      );
      return;
    }
    const cfg = snapshot.config ?? {};
    const accountId = params.accountId?.trim() || resolveDefaultAccountIdForPlugin(plugin, cfg);
    const input = sanitizeSetupInput(params.input);
    const validationError = plugin.setup.validateInput?.({ cfg, accountId, input });
    if (validationError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, validationError));
      return;
    }
    try {
      let next = plugin.setup.applyAccountConfig({ cfg, accountId, input });
      const name = params.name?.trim();
      if (name && plugin.setup.applyAccountName) {
        next = plugin.setup.applyAccountName({ cfg: next, accountId, name });
      }
      await writeConfigFile(next);

      // Hot-restart just this account so the new credentials take effect
      // now (the watcher can't be relied on for noopPrefix channels).
      try {
        await context.stopChannel(channelId, accountId);
      } catch {
        // Not running; fine.
      }
      const account = plugin.config.resolveAccount(next, accountId);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, next)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;
      let runtime = "stopped";
      if (enabled) {
        try {
          await context.startChannel(channelId, accountId);
          runtime = "started";
        } catch (err) {
          runtime = `error: ${formatForLog(err)}`;
        }
      }
      // Post-save probe so the UI can show a green/red result immediately.
      let probe: unknown;
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, next)
        : true;
      if (configured && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({ account, timeoutMs: 10_000, cfg: next });
        } catch (err) {
          probe = { ok: false, error: formatForLog(err) };
        }
      }
      respond(
        true,
        { ok: true, channel: channelId, accountId, runtime, configured, probe },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
