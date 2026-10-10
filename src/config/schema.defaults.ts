/**
 * PLAN-56 Phase 1 ("settings that tell the truth").
 *
 * `config.get` returns the config file with the LOAD-TIME defaults from
 * `defaults.ts` applied, but most feature flags are defaulted at the point of
 * use (`cfg.x?.enabled === false` treats "unset" as ON). The Settings form can
 * only render what it is told, so this file is the registry of every default
 * the form cannot see in the snapshot:
 *
 * - FIELD_DEFAULTS: unset ⇒ this effective value. One comment per entry cites
 *   the code that implements the default so the next person can re-verify.
 * - UNSET_MEANS_FALSE: booleans whose unset state really is OFF, so the form's
 *   "unchecked" rendering is already honest. Listed explicitly (with a
 *   citation) so `schema.defaults.test.ts` can fail when a new labelled boolean
 *   appears in neither list, i.e. when the form would start lying again.
 * - READ_ONLY_PATHS: rendered as text, never editable.
 * - DEPRECATED_PATHS: accepted this release with a load-time warning, removed
 *   next release; the form hides them.
 * - ADVANCED_PATHS: expert knobs hidden behind "Show advanced".
 */

export const FIELD_DEFAULTS: Record<string, unknown> = {
  // ---- the six that the plan found rendering OFF while actually ON ----
  // src/infra/update-startup.ts:86 — only `=== false` skips the check.
  "update.checkOnStart": true,
  // src/monitors/runtime.ts:60 — only `=== false` skips the engine.
  "monitors.enabled": true,
  // src/agents/tools/browser-tool.ts:251 — `!== false`.
  "browser.replay.enabled": true,
  // src/agents/tools/browser-tool.ts:429 and src/gateway/server-methods/browser-live.ts:32 — `=== false` turns it off.
  "browser.liveView.enabled": true,
  // src/agents/tools/tool-registry-hot-set.ts:180 — `agent?.enabled ?? global?.enabled ?? true`.
  "tools.hotSet.enabled": true,
  // src/memory/curiosity-researcher.ts:67 (DEFAULT_CURIOSITY_RESEARCH.enabled); :172 the legacy
  // memory.curiosity.autoResearch.enabled=false also disables it. Research also needs web search configured.
  "memory.curiosity.research.enabled": true,
  // src/memory/manager.ts:3189, :3387 — only `=== false` turns the curiosity engine off.
  "memory.curiosity.enabled": true,

  // ---- load-time defaults (defaults.ts) that have no zod default ----
  // src/config/defaults.ts:504 (applyP2pDefaults).
  "p2p.enabled": true,
  // src/config/defaults.ts:646 (applyCirclesDefaults).
  "circles.enabled": true,

  // ---- point-of-use defaults found by the grep catalogue ----
  // src/circles/service.ts:2109 — `!== false`.
  "circles.sandbox.enabled": true,
  // src/memory/dream-engine.ts:2697 — `=== false` skips the evolution pass.
  "skills.evolution.enabled": true,
  // src/memory/skill-evolution/housekeeping.ts:149 — `propagate !== false`.
  "skills.evolution.propagate": true,
  // src/memory/skill-evolution/validation-gate.ts:1082 — `descriptionRepair !== false`.
  "skills.evolution.descriptionRepair": true,
  // src/memory/skill-evolution/housekeeping.ts:178 — `routingRepair !== false`.
  "skills.evolution.routingRepair": true,
  // src/agents/skill-validation-policy.ts:47 — `validationTools?.exec !== false`.
  "skills.evolution.validationTools.exec": true,
  // src/memory/skill-marketability-predictor.ts:108 — `config.enabled ?? true`.
  "skills.marketability.predictor.enabled": true,
  // src/agents/model-catalog.ts:188 — `=== false` disables.
  "models.liveDiscovery.enabled": true,
  // src/infra/usage-ledger.ts:1723 — `raw !== false` (BITTERBOT_USAGE_LEDGER=0 also disables).
  "usage.ledger.enabled": true,
  // src/infra/model-pricing-live.ts:258 — `raw !== false`.
  "usage.pricing.liveRefresh": true,
  // src/agents/cache-trace.ts:186-188 — `?? true` for all three.
  "diagnostics.cacheTrace.includeMessages": true,
  "diagnostics.cacheTrace.includePrompt": true,
  "diagnostics.cacheTrace.includeSystem": true,
  // src/agents/agent-tools.ts:340 — `applyPatchConfig?.workspaceOnly !== false`.
  "tools.exec.applyPatch.workspaceOnly": true,
  // src/agents/bash-tools.exec.ts:152 — `defaults?.notifyOnExit !== false`.
  "tools.exec.notifyOnExit": true,
  // src/infra/outbound/outbound-policy.ts:110 — `!== false`.
  "tools.message.crossContext.allowWithinProvider": true,
  // src/infra/outbound/outbound-policy.ts:160 — `markerConfig?.enabled === false` turns it off.
  "tools.message.crossContext.marker.enabled": true,
  // src/infra/outbound/message-action-runner.ts:300 — `!== false`.
  "tools.message.broadcast.enabled": true,
  // src/agents/tools/web-search.ts:203 (resolveSearchEnabled) — unset ⇒ true; the tool still needs a provider key.
  "tools.web.search.enabled": true,
  // src/agents/tools/web-fetch.ts:91 (resolveFetchEnabled) — unset ⇒ true.
  "tools.web.fetch.enabled": true,
  // src/node-host/runner.ts:92 — `!== false`.
  "nodeHost.browserProxy.enabled": true,
  // src/agents/skills/refresh.ts:137 — `watch !== false`.
  "skills.load.watch": true,
  // src/agents/memory-search.ts:196 — `?? true`.
  "agents.defaults.memorySearch.enabled": true,
  // src/agents/memory-search.ts:198 — `?? true` (the help text used to say false).
  "agents.defaults.memorySearch.experimental.sessionMemory": true,
  // src/agents/memory-search.ts:264 — `?? true`.
  "agents.defaults.memorySearch.store.vector.enabled": true,
  // src/agents/memory-search.ts:278-280 — `?? true` for all three.
  "agents.defaults.memorySearch.sync.onSessionStart": true,
  "agents.defaults.memorySearch.sync.onSearch": true,
  "agents.defaults.memorySearch.sync.watch": true,
  // src/agents/memory-search.ts:93 (DEFAULT_HYBRID_ENABLED) via :303-305.
  "agents.defaults.memorySearch.query.hybrid.enabled": true,
  // src/agents/memory-search.ts:102 (DEFAULT_CACHE_ENABLED) via :324.
  "agents.defaults.memorySearch.cache.enabled": true,
  // src/auto-reply/commands-registry.ts:512 — `text !== false`.
  "commands.text": true,
  // src/slack/monitor/provider.ts:117, src/telegram/bot-message-context.ts:344 — `!== false`.
  "commands.useAccessGroups": true,
  // src/browser/constants.ts:2 (DEFAULT_BROWSER_EVALUATE_ENABLED) via src/agents/sandbox/context.ts:113.
  "browser.evaluateEnabled": true,
  // src/agents/tools/browser-tool.ts:264 — `=== false` disables.
  "browser.perAgentProfiles": true,
  // src/agents/tools/shop-tool.ts:55 — `=== false` disables.
  "shop.enabled": true,
  // src/plugins/enable.ts:24 — `=== false` disables.
  "plugins.enabled": true,
};

/**
 * Labelled booleans whose unset state is genuinely OFF. The form's unchecked
 * rendering is correct for these; the entry (with its citation) is what keeps
 * the settings-truth test honest when a label is added.
 */
export const UNSET_MEANS_FALSE: Record<string, string> = {
  "a2a.enabled":
    "src/config/defaults.ts:548 — `a2a.enabled ?? false` (load-time, visible in config.get).",
  "a2a.marketplace.enabled": "src/config/defaults.ts:590 — load-time `enabled: false`.",
  "forage.nightShift.enabled":
    "src/memory/forage-client.ts:112 — `cfg.enabled !== true` returns early.",
  "forage.audit.enabled": "src/gateway/a2a/a2a-http.ts:423 — `=== true`.",
  "skills.evolution.requireCrossModel":
    "src/memory/dream-engine.ts:2792 — only a truthy value sets requireCrossModel.",
  "skills.skillSeekers.enabled": "src/agents/tools/skill-seekers-tool.ts:68 — `!== true` refuses.",
  "skills.skillSeekers.trending.enabled":
    "src/memory/manager.ts:3678 — `!== true` skips the sweep.",
  "agents.defaults.harnessEvolve.enabled": "src/memory/manager.ts:3037 — `?? false`.",
  "memory.architectEvolution.enabled": "src/memory/manager.ts:4130 — `=== true`.",
  "memory.curiosity.research.strictEgress":
    "src/memory/curiosity-researcher.ts:75 — DEFAULT_CURIOSITY_RESEARCH.strictEgress is false.",
  "tools.wallet.enabled":
    "src/agents/tools/a2a-client-tool.ts:162 — `=== true`; money surfaces never self-enable.",
  "tools.wallet.x402.enabled": "src/gateway/server-methods/wallet.ts:226 — `?? false`.",
  "diagnostics.enabled": "src/infra/diagnostic-events.ts:160 — `=== true`.",
  "diagnostics.otel.enabled":
    "No reader in src/ or extensions/; OTel is env-driven (src/observability/otel.ts:42). Candidate for deprecation.",
  "diagnostics.otel.traces": "No reader (see diagnostics.otel.enabled).",
  "diagnostics.otel.metrics": "No reader (see diagnostics.otel.enabled).",
  "diagnostics.otel.logs": "No reader (see diagnostics.otel.enabled).",
  "diagnostics.cacheTrace.enabled":
    "src/agents/cache-trace.ts:170 — `envEnabled ?? config?.enabled ?? false`.",
  "tools.media.image.enabled":
    "src/media-understanding/resolve.ts:165 — without `enabled: true` or explicit models no model is resolved (runner.ts:607 only refuses on `=== false`).",
  "tools.media.audio.enabled":
    "src/media-understanding/resolve.ts:165 — same as tools.media.image.enabled.",
  "tools.media.video.enabled":
    "src/media-understanding/resolve.ts:165 — same as tools.media.image.enabled.",
  "tools.links.enabled":
    "src/link-understanding/runner.ts:113 — `!config || config.enabled === false` returns.",
  "tools.exec.applyPatch.enabled": "src/agents/agent-tools.ts:342 — `!!applyPatchConfig?.enabled`.",
  "tools.fs.workspaceOnly": "src/agents/agent-tools.ts:336 — `=== true`.",
  "tools.exec.notifyOnExitEmptySuccess": "src/agents/bash-tools.exec.ts:153 — `=== true`.",
  "tools.message.allowCrossContextSend":
    "src/infra/outbound/outbound-policy.ts:104 — truthy check.",
  "tools.message.crossContext.allowAcrossProviders":
    "src/infra/outbound/outbound-policy.ts:112 — `=== true`.",
  "gateway.controlUi.bootstrapPairing":
    "src/gateway/bootstrap-pairing.ts:25 — unset ⇒ BITTERBOT_BOOTSTRAP_PAIRING=1 decides, else off.",
  "gateway.controlUi.allowInsecureAuth":
    "src/gateway/server/ws-connection/message-handler.ts:356 — `=== true`.",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "src/gateway/server/ws-connection/message-handler.ts:358 — `=== true`.",
  "gateway.http.endpoints.chatCompletions.enabled":
    "src/gateway/server-runtime-config.ts:45 — `?? false`.",
  "commands.bash": "src/auto-reply/commands-registry.ts:104 — `=== true`.",
  "commands.config": "src/auto-reply/commands-registry.ts:98 — `=== true`.",
  "commands.debug": "src/auto-reply/reply/commands-config.ts:193 — `!== true` refuses.",
  "commands.restart": "src/agents/tools/gateway-tool.ts:78 — `!== true` refuses.",
  "payments.link.enabled": "src/payments/link/cli.ts:34 — `=== true`.",
  "payments.privacy.enabled": "src/payments/privacy/rail.ts:36 — `=== true`.",
  "payments.privacy.sandbox": "src/payments/privacy/rail.ts:38 — `=== true`.",
  "messages.suppressToolErrors": "src/agents/embedded-runner/run/payloads.ts:257 — `Boolean(...)`.",
  "channels.telegram.network.autoSelectFamily":
    "src/telegram/network-config.ts:32 — tri-state: unset means no override (Node's own default), not false.",
  "channels.whatsapp.selfChatMode": "src/web/accounts.ts:157 — falsy ⇒ off.",
  "channels.discord.intents.presence": "src/discord/monitor/provider.ts:576 — truthy check.",
  "channels.discord.intents.guildMembers":
    "src/discord/monitor/provider.ts (intents block) — truthy check.",
  "channels.discord.pluralkit.enabled":
    "src/discord/monitor/message-handler.preflight.ts:91 — `Boolean(pluralkitConfig?.enabled)`.",
  "channels.slack.allowBots": "src/slack/monitor/message-handler/prepare.ts:90-93 — `?? false`.",
  "channels.slack.thread.inheritParent": "src/slack/monitor/provider.ts:122 — `?? false`.",
};

/** Rendered as text in the form; written by Bitterbot, never by the user. */
export const READ_ONLY_PATHS: ReadonlySet<string> = new Set([
  "meta.lastTouchedVersion",
  "meta.lastTouchedAt",
]);

/**
 * Accepted this release, warned about at load, removed next release. The
 * Settings form does not show them; the raw editor still can.
 */
export const DEPRECATED_PATHS: Record<string, string> = {
  "memory.backend":
    'memory.backend is inert: "builtin" is the only accepted value and nothing reads it. It will be removed next release.',
  "memory.curiosity.autoResearch.enabled":
    "memory.curiosity.autoResearch.enabled is a legacy alias of memory.curiosity.research.enabled; set that key instead. It will be removed next release.",
  "agents.defaults.runtime.engine":
    'agents.defaults.runtime.engine is obsolete: the pi engine was removed (PLAN-52), "pi" runs the bitterbot runtime with a warning. It will be removed next release.',
  "agents.list[].runtime.engine":
    'agents.list[].runtime.engine is obsolete: the pi engine was removed (PLAN-52), "pi" runs the bitterbot runtime with a warning. It will be removed next release.',
  "agents.defaults.compaction.mode":
    'agents.defaults.compaction.mode: "safeguard" is accepted and has no effect (see LIMITATIONS.md, "Execution and isolation"); "default" is the only live mode. The key will be removed next release.',
  "agents.defaults.contextPruning":
    'agents.defaults.contextPruning is accepted and has no effect (see LIMITATIONS.md, "Execution and isolation"). It will be removed next release.',
};

/**
 * Deprecated paths that only warn for one specific value (every other value
 * is live and keeps working).
 */
export const DEPRECATED_ONLY_WHEN: Record<string, unknown> = {
  "agents.defaults.compaction.mode": "safeguard",
};

/**
 * Expert knobs. A hinted path is `advanced` when it equals one of these or
 * starts with one of them followed by a dot, unless it is listed in
 * ADVANCED_EXCEPTIONS. The rule: tuning numbers, transport internals, debug
 * output and anything the onboarding wizard never asks about. Every on/off
 * switch of a user-facing feature stays visible.
 */
export const ADVANCED_PATHS: ReadonlySet<string> = new Set([
  "gateway.controlUi",
  "gateway.reload",
  "gateway.nodes",
  "gateway.remote",
  "gateway.http",
  "logging",
  "diagnostics",
  "session",
  "auth.cooldowns",
  "agents.defaults.compaction",
  "agents.defaults.bootstrapMaxChars",
  "agents.defaults.bootstrapTotalMaxChars",
  "agents.defaults.envelopeTimezone",
  "agents.defaults.envelopeTimestamp",
  "agents.defaults.envelopeElapsed",
  "agents.defaults.memorySearch.sync",
  "agents.defaults.memorySearch.query",
  "agents.defaults.memorySearch.cache",
  "agents.defaults.memorySearch.chunking",
  "agents.defaults.memorySearch.store",
  "agents.defaults.memorySearch.remote",
  "agents.defaults.memorySearch.experimental",
  "agents.defaults.memorySearch.local",
  "agents.defaults.memorySearch.fallback",
  "agents.defaults.humanDelay",
  "circles.sandbox",
  "forage.audit",
  "skills.evolution",
  "skills.load.watchDebounceMs",
  "tools.hotSet.max",
  "tools.hotSet.always",
  "tools.hotSet.perLane",
  "tools.resultMaxChars",
  "tools.exec.pathPrepend",
  "tools.exec.safeBins",
  "tools.exec.notifyOnExit",
  "tools.exec.notifyOnExitEmptySuccess",
  "tools.message.crossContext.marker",
  "tools.web.fetch.maxRedirects",
  "tools.web.fetch.userAgent",
  "tools.web.fetch.cacheTtlMinutes",
  "tools.web.search.cacheTtlMinutes",
  "tools.web.search.timeoutSeconds",
  "messages.inbound.debounceMs",
  "browser.remoteCdpTimeoutMs",
  "browser.remoteCdpHandshakeTimeoutMs",
  "browser.liveView.maxFps",
  "browser.liveView.quality",
  "browser.snapshotDefaults",
  "channels.telegram.retry",
  "channels.telegram.draftChunk",
  "channels.telegram.network",
  "channels.telegram.timeoutSeconds",
  "channels.discord.retry",
  "channels.discord.maxLinesPerMessage",
  "channels.slack.thread",
  "plugins.installs",
  "usage.pricing.openRouterUrl",
  "update.promptBehindCommits",
]);

/** Paths under an ADVANCED_PATHS prefix that must stay in the plain view. */
export const ADVANCED_EXCEPTIONS: ReadonlySet<string> = new Set([
  "skills.evolution.enabled",
  "skills.evolution.propagate",
  "circles.sandbox.enabled",
  "forage.audit.enabled",
  "diagnostics.enabled",
]);

export function isAdvancedPath(path: string): boolean {
  if (ADVANCED_EXCEPTIONS.has(path)) {
    return false;
  }
  if (ADVANCED_PATHS.has(path)) {
    return true;
  }
  for (const prefix of ADVANCED_PATHS) {
    if (path.startsWith(`${prefix}.`)) {
      return true;
    }
  }
  return false;
}

export function isReadOnlyPath(path: string): boolean {
  return READ_ONLY_PATHS.has(path) || path === "meta" || path.startsWith("meta.");
}
