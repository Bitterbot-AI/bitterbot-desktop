import {
  applyAccountNameToChannelSection,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  detectBinary,
  formatPairingApproveHint,
  getChatChannelMeta,
  listSignalAccountIds,
  looksLikeSignalTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  normalizeSignalMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  setAccountEnabledInConfigSection,
  signalOnboardingAdapter,
  SignalConfigSchema,
  startSignalLinkQr,
  waitForSignalLinkQr,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ResolvedSignalAccount,
} from "bitterbot/plugin-sdk";
import { getSignalRuntime } from "./runtime.js";

const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getSignalRuntime().channel.signal.messageActions?.listActions?.(ctx) ?? [],
  supportsAction: (ctx) =>
    getSignalRuntime().channel.signal.messageActions?.supportsAction?.(ctx) ?? false,
  handleAction: async (ctx) => {
    const ma = getSignalRuntime().channel.signal.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Signal message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

const meta = getChatChannelMeta("signal");

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...meta,
  },
  onboarding: signalOnboardingAdapter,
  pairing: {
    idLabel: "signalNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^signal:/i, ""),
    notifyApproval: async ({ id }) => {
      await getSignalRuntime().channel.signal.sendMessageSignal(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
  },
  actions: signalMessageActions,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.signal"] },
  availability: async ({ cfg }) => {
    // An external signal-cli daemon (httpUrl) needs no local binary.
    const hasExternalDaemon = listSignalAccountIds(cfg).some((accountId) =>
      Boolean(resolveSignalAccount({ cfg, accountId }).config.httpUrl?.trim()),
    );
    if (hasExternalDaemon) {
      return { available: true };
    }
    const cliPath = cfg.channels?.signal?.cliPath?.trim() || "signal-cli";
    const found = await detectBinary(cliPath);
    return found
      ? { available: true }
      : {
          available: false,
          reason: `signal-cli not found on the gateway host (looked for "${cliPath}"). Install it or set channels.signal.cliPath.`,
        };
  },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.signal?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.signal.accounts.${resolvedAccountId}.`
        : "channels.signal.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("signal"),
        normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Signal groups: groupPolicy="open" allows any member to trigger the bot. Set channels.signal.groupPolicy="allowlist" + channels.signal.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeSignalMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSignalTargetId,
      hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "signal",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            signal: {
              ...next.channels?.signal,
              enabled: true,
              ...(input.signalNumber ? { account: input.signalNumber } : {}),
              ...(input.cliPath ? { cliPath: input.cliPath } : {}),
              ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
              ...(input.httpHost ? { httpHost: input.httpHost } : {}),
              ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          signal: {
            ...next.channels?.signal,
            enabled: true,
            accounts: {
              ...next.channels?.signal?.accounts,
              [accountId]: {
                ...next.channels?.signal?.accounts?.[accountId],
                enabled: true,
                ...(input.signalNumber ? { account: input.signalNumber } : {}),
                ...(input.cliPath ? { cliPath: input.cliPath } : {}),
                ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
                ...(input.httpHost ? { httpHost: input.httpHost } : {}),
                ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getSignalRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "signal", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "signal", ...result };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gatewayMethods: ["web.login.start", "web.login.wait"],
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      return getSignalRuntime().channel.signal.monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
    loginWithQrStart: async ({ accountId, timeoutMs }) => {
      const runtime = getSignalRuntime();
      const cfg = runtime.config.loadConfig();
      const resolvedAccountId = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
      const account = resolveSignalAccount({ cfg, accountId: resolvedAccountId });
      const cliPath =
        account.config.cliPath?.trim() || cfg.channels?.signal?.cliPath?.trim() || "signal-cli";
      return await startSignalLinkQr({
        accountId: resolvedAccountId,
        cliPath,
        uriTimeoutMs: timeoutMs,
      });
    },
    loginWithQrWait: async ({ accountId, timeoutMs }) => {
      return await waitForSignalLinkQr({
        accountId: normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID),
        timeoutMs,
      });
    },
  },
};
