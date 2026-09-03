import type { BitterbotConfig } from "./types.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import { resolveTalkApiKey } from "./talk.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

type AnthropicAuthDefaultsMode = "api_key" | "oauth";

const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-8",
  sonnet: "anthropic/claude-sonnet-4-5",

  // OpenAI
  gpt: "openai/gpt-5.2",
  "gpt-mini": "openai/gpt-5-mini",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
};

const DEFAULT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const DEFAULT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text"];
const DEFAULT_MODEL_MAX_TOKENS = 8192;

type ModelDefinitionLike = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveModelCost(
  raw?: Partial<ModelDefinitionConfig["cost"]>,
): ModelDefinitionConfig["cost"] {
  return {
    input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
    output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
    cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
    cacheWrite:
      typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite,
  };
}

function resolveAnthropicDefaultAuthMode(cfg: BitterbotConfig): AnthropicAuthDefaultsMode | null {
  const profiles = cfg.auth?.profiles ?? {};
  const anthropicProfiles = Object.entries(profiles).filter(
    ([, profile]) => profile?.provider === "anthropic",
  );

  const order = cfg.auth?.order?.anthropic ?? [];
  for (const profileId of order) {
    const entry = profiles[profileId];
    if (!entry || entry.provider !== "anthropic") {
      continue;
    }
    if (entry.mode === "api_key") {
      return "api_key";
    }
    if (entry.mode === "oauth" || entry.mode === "token") {
      return "oauth";
    }
  }

  const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
  const hasOauth = anthropicProfiles.some(
    ([, profile]) => profile?.mode === "oauth" || profile?.mode === "token",
  );
  if (hasApiKey && !hasOauth) {
    return "api_key";
  }
  if (hasOauth && !hasApiKey) {
    return "oauth";
  }

  if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
    return "oauth";
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return "api_key";
  }
  return null;
}

function resolvePrimaryModelRef(raw?: string): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const aliasKey = trimmed.toLowerCase();
  return DEFAULT_MODEL_ALIASES[aliasKey] ?? trimmed;
}

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

export function applyMessageDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const messages = cfg.messages;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckScope) {
    return cfg;
  }

  const nextMessages = messages ? { ...messages } : {};
  nextMessages.ackReactionScope = "group-mentions";
  return {
    ...cfg,
    messages: nextMessages,
  };
}

export function applySessionDefaults(
  cfg: BitterbotConfig,
  options: SessionDefaultsOptions = {},
): BitterbotConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) {
    return cfg;
  }

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  const next: BitterbotConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey is ignored; main session is always "main".');
  }

  return next;
}

export function applyTalkApiKey(config: BitterbotConfig): BitterbotConfig {
  const resolved = resolveTalkApiKey();
  if (!resolved) {
    return config;
  }
  const existing = config.talk?.apiKey?.trim();
  if (existing) {
    return config;
  }
  return {
    ...config,
    talk: {
      ...config.talk,
      apiKey: resolved,
    },
  };
}

export function applyModelDefaults(cfg: BitterbotConfig): BitterbotConfig {
  let mutated = false;
  let nextCfg = cfg;

  const providerConfig = nextCfg.models?.providers;
  if (providerConfig) {
    const nextProviders = { ...providerConfig };
    for (const [providerId, provider] of Object.entries(providerConfig)) {
      const models = provider.models;
      if (!Array.isArray(models) || models.length === 0) {
        continue;
      }
      let providerMutated = false;
      const nextModels = models.map((model) => {
        const raw = model as ModelDefinitionLike;
        let modelMutated = false;

        const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
        if (raw.reasoning !== reasoning) {
          modelMutated = true;
        }

        const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
        if (raw.input === undefined) {
          modelMutated = true;
        }

        const cost = resolveModelCost(raw.cost);
        const costMutated =
          !raw.cost ||
          raw.cost.input !== cost.input ||
          raw.cost.output !== cost.output ||
          raw.cost.cacheRead !== cost.cacheRead ||
          raw.cost.cacheWrite !== cost.cacheWrite;
        if (costMutated) {
          modelMutated = true;
        }

        const contextWindow = isPositiveNumber(raw.contextWindow)
          ? raw.contextWindow
          : DEFAULT_CONTEXT_TOKENS;
        if (raw.contextWindow !== contextWindow) {
          modelMutated = true;
        }

        const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
        const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
        const maxTokens = Math.min(rawMaxTokens, contextWindow);
        if (raw.maxTokens !== maxTokens) {
          modelMutated = true;
        }

        if (!modelMutated) {
          return model;
        }
        providerMutated = true;
        return {
          ...raw,
          reasoning,
          input,
          cost,
          contextWindow,
          maxTokens,
        } as ModelDefinitionConfig;
      });

      if (!providerMutated) {
        continue;
      }
      nextProviders[providerId] = { ...provider, models: nextModels };
      mutated = true;
    }

    if (mutated) {
      nextCfg = {
        ...nextCfg,
        models: {
          ...nextCfg.models,
          providers: nextProviders,
        },
      };
    }
  }

  const existingAgent = nextCfg.agents?.defaults;
  if (!existingAgent) {
    return mutated ? nextCfg : cfg;
  }
  const existingModels = existingAgent.models ?? {};
  if (Object.keys(existingModels).length === 0) {
    return mutated ? nextCfg : cfg;
  }

  const nextModels: Record<string, { alias?: string }> = {
    ...existingModels,
  };

  for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    const entry = nextModels[target];
    if (!entry) {
      continue;
    }
    if (entry.alias !== undefined) {
      continue;
    }
    nextModels[target] = { ...entry, alias };
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...nextCfg,
    agents: {
      ...nextCfg.agents,
      defaults: { ...existingAgent, models: nextModels },
    },
  };
}

export function applyAgentDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const agents = cfg.agents;
  const defaults = agents?.defaults;
  const hasMax =
    typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
  const hasSubMax =
    typeof defaults?.subagents?.maxConcurrent === "number" &&
    Number.isFinite(defaults.subagents.maxConcurrent);
  if (hasMax && hasSubMax) {
    return cfg;
  }

  let mutated = false;
  const nextDefaults = defaults ? { ...defaults } : {};
  if (!hasMax) {
    nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
    mutated = true;
  }

  const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
  if (!hasSubMax) {
    nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: {
        ...nextDefaults,
        subagents: nextSubagents,
      },
    },
  };
}

export function applyLoggingDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const logging = cfg.logging;
  if (!logging) {
    return cfg;
  }
  if (logging.redactSensitive) {
    return cfg;
  }
  return {
    ...cfg,
    logging: {
      ...logging,
      redactSensitive: "tools",
    },
  };
}

export function applyContextPruningDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) {
    return cfg;
  }

  const authMode = resolveAnthropicDefaultAuthMode(cfg);
  if (!authMode) {
    return cfg;
  }

  let mutated = false;
  const nextDefaults = { ...defaults };
  const contextPruning = defaults.contextPruning ?? {};
  const heartbeat = defaults.heartbeat ?? {};

  if (defaults.contextPruning?.mode === undefined) {
    nextDefaults.contextPruning = {
      ...contextPruning,
      mode: "cache-ttl",
      ttl: defaults.contextPruning?.ttl ?? "1h",
    };
    mutated = true;
  }

  if (defaults.heartbeat?.every === undefined) {
    nextDefaults.heartbeat = {
      ...heartbeat,
      every: authMode === "oauth" ? "1h" : "30m",
    };
    mutated = true;
  }

  if (authMode === "api_key") {
    const nextModels = defaults.models ? { ...defaults.models } : {};
    let modelsMutated = false;

    for (const [key, entry] of Object.entries(nextModels)) {
      const parsed = parseModelRef(key, "anthropic");
      if (!parsed || parsed.provider !== "anthropic") {
        continue;
      }
      const current = entry ?? {};
      const params = (current as { params?: Record<string, unknown> }).params ?? {};
      if (typeof params.cacheRetention === "string") {
        continue;
      }
      nextModels[key] = {
        ...(current as Record<string, unknown>),
        params: { ...params, cacheRetention: "short" },
      };
      modelsMutated = true;
    }

    const primary = resolvePrimaryModelRef(defaults.model?.primary ?? undefined);
    if (primary) {
      const parsedPrimary = parseModelRef(primary, "anthropic");
      if (parsedPrimary?.provider === "anthropic") {
        const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
        const entry = nextModels[key];
        const current = entry ?? {};
        const params = (current as { params?: Record<string, unknown> }).params ?? {};
        if (typeof params.cacheRetention !== "string") {
          nextModels[key] = {
            ...(current as Record<string, unknown>),
            params: { ...params, cacheRetention: "short" },
          };
          modelsMutated = true;
        }
      }
    }

    if (modelsMutated) {
      nextDefaults.models = nextModels;
      mutated = true;
    }
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: nextDefaults,
    },
  };
}

export function applyCompactionDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) {
    return cfg;
  }
  const compaction = defaults?.compaction;
  if (compaction?.mode) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        compaction: {
          ...compaction,
          mode: "safeguard",
        },
      },
    },
  };
}

/**
 * Hardcoded fallback bootstrap peers shipped with the binary.
 * Used as a backstop if `bootstrapDns` resolution fails (DNS outage,
 * stale TTL, registrar misconfig). Merged with DNS-resolved peers, not
 * a replacement — the DNS path is still primary so the network can
 * rotate hosts without a client release.
 *
 * Add new bootnodes here as they come online; remove only when a node
 * is permanently retired.
 */
const FALLBACK_BOOTSTRAP_PEERS: readonly string[] = [
  // DigitalOcean relay fleet (deployed 2026-04-28) — fixed-IP nodes that are
  // both the relay fleet and 3 of the 5 genesis-trust quorum members. These are
  // the true DNS-independent backstop: raw /ip4 multiaddrs that resolve even if
  // p2p.bitterbot.ai (the primary DNS path) is down. Keep these current with the
  // fleet; primary discovery is still DNS, so hosts can rotate without a release.
  // nyc1
  "/ip4/142.93.113.64/tcp/9100/p2p/12D3KooWRWqC9ha4zvFpLTWdKWr3B8EaiQnWqr2Mp3vyRSNQNPJN",
  // fra1
  "/ip4/46.101.181.98/tcp/9100/p2p/12D3KooWMnnCHGVtZxyAFaJoEzk2hT1eD3SEvjLDiUNwiJsXdRty",
  // sgp1
  "/ip4/139.59.233.83/tcp/9100/p2p/12D3KooWNZdviN1579x6LrLQt78d6VRZczLHbBWhyyXzoun2k2L3",
  // Railway bootnode #1 (us-east, persistent volume) — retained as an extra
  // backstop. Now that the DO fleet above is the primary fallback, this line
  // can be removed once the Railway service is retired.
  "/dns4/metro.proxy.rlwy.net/tcp/12838/p2p/12D3KooWCwCCFMHCVv8eXZnAGMTUjTDPPePfYRTJ1fZvRpqcQXKt",
];

export function applyP2pDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const p2p = cfg.p2p ?? {};
  // Merge fallback peers with any user-supplied ones, dedupe.
  const userPeers = p2p.bootstrapPeers ?? [];
  const mergedPeers = Array.from(new Set([...FALLBACK_BOOTSTRAP_PEERS, ...userPeers]));
  return {
    ...cfg,
    p2p: {
      enabled: true,
      bootstrapDns: "p2p.bitterbot.ai",
      relayMode: "auto",
      ...p2p,
      bootstrapPeers: mergedPeers,
    },
  };
}

/**
 * True when this node has everything it needs to receive and verify x402
 * payments: wallet not explicitly disabled, and full CDP credentials present.
 * Mirrors the credential check in wallet-service initProvider(); the receive
 * address itself is auto-derived at verification time (payment.ts falls back
 * to the live wallet capability), so credentials are the only precondition.
 */
export function isEarningCapable(cfg: BitterbotConfig): boolean {
  const wallet = cfg.tools?.wallet;
  if (wallet?.enabled === false) return false;
  const apiKeyId = wallet?.cdpApiKeyId ?? process.env.CDP_API_KEY_ID;
  const apiKeySecret = wallet?.cdpApiKeySecret ?? process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  return Boolean(apiKeyId && apiKeySecret && walletSecret);
}

/**
 * A2A protocol defaults. The protocol is on by default so external A2A clients
 * (other Bitterbot nodes, partner agents, etc.) can discover and call this
 * agent. Authentication is bearer + loopback bypass; payment (charging peers
 * x402 USDC for skill execution) defaults ON when the node is earning-capable
 * (PLAN-29 Phase 0: a node that cannot earn cannot participate in the bounty
 * economy) and OFF otherwise, since an enabled gate 402s every inbound
 * message/send and a wallet-less node could never be paid. Explicit
 * a2a.payment.enabled always wins over the derived default.
 *
 * Defaults are deep-merged with user config so operators can override any
 * single field without re-specifying the rest of the block.
 */
export function applyA2aDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const a2a = cfg.a2a ?? {};
  return {
    ...cfg,
    a2a: {
      // V1 default flip (PLAN-41 D-D): the agent-to-agent surface is opt-in.
      enabled: a2a.enabled ?? false,
      ...(a2a.name !== undefined ? { name: a2a.name } : {}),
      ...(a2a.description !== undefined ? { description: a2a.description } : {}),
      ...(a2a.url !== undefined ? { url: a2a.url } : {}),
      authentication: {
        type: "bearer",
        ...a2a.authentication,
      },
      skills: {
        // PLAN-43 Phase 0: advertising skills on the public agent card is
        // opt-in (closes the auto-list-everything disclosure footgun). An
        // explicit allowlist without `expose` implies exposure of exactly
        // the allowlisted skills.
        expose: a2a.skills?.allowlist ? "all" : "none",
        ...a2a.skills,
      },
      // PLAN-43 s3.2b: remote-caller execution bounds. The tool floor
      // itself is hardcoded in agents/a2a-remote-policy.ts; these are the
      // resource caps and the operator's (floor-limited) tool grants.
      attestation: {
        enabled: true,
        ...a2a.attestation,
      },
      remoteExecution: {
        maxInputChars: 32_000,
        maxOutputChars: 64_000,
        timeoutSeconds: 600,
        ...a2a.remoteExecution,
      },
      payment: {
        enabled: isEarningCapable(cfg),
        ...a2a.payment,
        x402: {
          minPayment: 0.01,
          ...a2a.payment?.x402,
        },
      },
      mesh: {
        delegation: false,
        gatewayFeePercent: 10,
        ...a2a.mesh,
      },
      marketplace: {
        enabled: false, // V1 default flip (PLAN-41 D-D): opt-in.
        ...a2a.marketplace,
        pricing: {
          basePriceUsdc: 0.01,
          minPriceUsdc: 0.001,
          maxPriceUsdc: 1.0,
          minExecutionsForListing: 3,
          minSuccessRateForListing: 0.6,
          ...a2a.marketplace?.pricing,
        },
        client: {
          maxTaskCostUsdc: 0.5,
          dailySpendLimitUsdc: 2.0,
          taskTimeoutMs: 60_000,
          ...a2a.marketplace?.client,
        },
      },
      erc8004: {
        enabled: false,
        chain: "base",
        cacheTtlMs: 5 * 60 * 1000,
        ...a2a.erc8004,
      },
    },
  };
}

/**
 * PLAN-31: Circles defaults. As of the red-team phase (2026-07-09) circles
 * are ON BY DEFAULT fleet-wide so the connection surface can be tested and
 * attacked at scale. The plan's §8 "dark until the C2 security review" posture
 * is satisfied by turning it on FOR that review. An explicit
 * `circles.enabled: false` still opts any node out. Nodes without a
 * `circles.a2aPublicUrl` can still receive/serve circle verbs and run the
 * practice partner; they just cannot originate invites or dial peers.
 */
/**
 * Default fleet mailbox (PLAN-36 Phase 1). Store-and-forward for offline /
 * asymmetric peers so a friend receives on wake without either side hosting
 * anything. The host stores X25519-sealed ciphertext it cannot read (a
 * metadata-only relay). Runs the slim `pnpm mailbox:host` service
 * (src/gateway/a2a/mailbox-host.ts); deploy guide: docs/network/mailbox-host.md.
 *
 * DEPLOY DEPENDENCY: this URL must resolve to a running mailbox host. Until it
 * does, offline delivery falls through gracefully (the send is reported failed;
 * the fast poll's dial times out at debug level — no crash, no spam). Override
 * with `circles.mailbox.url` (or `enabled: false`) per node.
 */
export const DEFAULT_CIRCLES_MAILBOX_URL = "https://mailbox.bitterbot.ai";

export function applyCirclesDefaults(cfg: BitterbotConfig): BitterbotConfig {
  const circles = cfg.circles ?? {};
  return {
    ...cfg,
    circles: {
      enabled: circles.enabled ?? true,
      ...(circles.a2aPublicUrl !== undefined ? { a2aPublicUrl: circles.a2aPublicUrl } : {}),
      ...(circles.displayName !== undefined ? { displayName: circles.displayName } : {}),
      // Default fleet mailbox; user url/serve/enabled override it.
      mailbox: { url: DEFAULT_CIRCLES_MAILBOX_URL, ...circles.mailbox },
      briefing: { enabled: true, ...circles.briefing },
      practicePartner: { enabled: true, ...circles.practicePartner },
    },
  };
}

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
