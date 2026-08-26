import type { A2aConfig } from "./types.a2a.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CirclesConfig } from "./types.circles.js";
import type { CommerceConfig } from "./types.commerce.js";
import type { CronConfig } from "./types.cron.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { P2pConfig } from "./types.p2p.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";

export type BitterbotConfig = {
  meta?: {
    /** Last Bitterbot version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Automatic update checks (boot + every 6h). Set false to disable. */
    checkOnStart?: boolean;
    /**
     * Git installs: prompt the Control UI to update once the node falls this
     * many commits behind upstream (default 20; the periodic staleness check
     * broadcasts the "update" gateway event when crossed).
     */
    promptBehindCommits?: number;
    /**
     * Automatic post-update rollback (git installs). When a freshly-updated
     * gateway never confirms a healthy boot before the boot-verify deadline,
     * a detached watchdog performs ONE guarded `git reset --hard` to the
     * pre-update sha (clean worktree only, config/DB untouched, once-only
     * latch), rebuilds, and best-effort restarts. Default: enabled.
     */
    autoRollback?: {
      enabled?: boolean;
    };
    /**
     * DEPRECATED (PLAN-39 Phase 4): the Control-UI restarter it gated is gone —
     * the gateway serves the UI from dist/control-ui per request, so an update
     * needs no UI process bounce. The key is still accepted so existing configs
     * that set it keep validating (a strict schema rejecting a removed key
     * refuses to boot: the circles kill-switch bug, 024c7fa). Ignored.
     */
    uiRestart?: {
      enabled?: boolean;
    };
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for Bitterbot UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  skills?: SkillsConfig;
  /** PLAN-29: Forage bounty economy settings. */
  forage?: {
    /** Night Shift: autonomous hunting of mesh bounties while idle. */
    nightShift?: {
      /** Default: true (monitoring-only, receive-only money flow). */
      enabled?: boolean;
      /** Max simultaneous hunts. Default: 2. */
      maxConcurrentHunts?: number;
      /** Max per-bounty reward the node will take on. Default: $2. */
      maxRewardUsdc?: number;
    };
    /**
     * Bounty pools (Phase 4). Default: FALSE and stays false until
     * payments counsel review (PLAN-26 precedent) — this is the one
     * Forage surface that moves other people's money.
     */
    pools?: {
      enabled?: boolean;
    };
    /**
     * PLAN-30 G0.1: probabilistic re-observation of heartbeat check-ins
     * (BOINC-style adaptive rate, two-tier verdicts). Default: true.
     * Disabling also freezes trust-tier promotion past the audit gate —
     * fail-safe by design.
     */
    audit?: {
      enabled?: boolean;
    };
    /**
     * PLAN-30 G0.4: Genesis seeded-demand accounting. treasuryWallets is
     * the PUBLISHED list of operator wallets that post seeded bounties;
     * the seeded/organic metric split keys on it (never on self-declared
     * flags), and per-hunter daily earnings from treasury-posted streams
     * are capped so the seed pool cannot be farmed.
     */
    genesis?: {
      treasuryWallets?: string[];
      /** Default: $1/day per hunter from treasury-posted streams. */
      maxDailyTreasuryUsdcPerHunter?: number;
    };
  };
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  p2p?: P2pConfig;
  a2a?: A2aConfig;
  commerce?: CommerceConfig;
  /** PLAN-31: Circles, the agent social fabric. ON by default since the 2026-07-09 red-team phase (§8). */
  circles?: CirclesConfig;
  cron?: CronConfig;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: BitterbotConfig;
  valid: boolean;
  config: BitterbotConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
