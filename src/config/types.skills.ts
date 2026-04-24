export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

export type SkillsP2pConfig = {
  /** Ingestion policy for skills received via P2P. Default: "deny". */
  ingestPolicy?: "auto" | "review" | "deny";
  /** Trusted peer public keys (base64 Ed25519) that bypass quarantine in auto mode. */
  trustList?: string[];
  /** Directory for quarantined incoming skills. */
  quarantineDir?: string;
  /** Maximum skills ingested per hour. Default: 20. */
  maxIngestedPerHour?: number;
};

export type SkillsAgentskillsConfig = {
  /** Enable the agentskills.io import bridge. Default: false (opt-in). */
  enabled?: boolean;
  /** Base URL for slug resolution. Default: "https://agentskills.io". */
  registryBaseUrl?: string;
  /** Trust level for imported skills. Default: "review" (quarantine first). */
  defaultTrust?: "auto" | "review";
  /** Minimum transformScore (0-1) required before an origin-derived crystal may be published to the paid marketplace. Default: 0.5. */
  transformThreshold?: number;
  /** Royalty split (basis points) retained for the upstream registry. Default: 0. */
  royaltyBps?: number;
  /** Maximum bytes for an imported SKILL.md or tarball. Default: 1 MB. */
  maxBytes?: number;
};

import type { SkillSeekersConfig } from "./types.skill-seekers.js";

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  entries?: Record<string, SkillConfig>;
  /** P2P skill ingestion settings. */
  p2p?: SkillsP2pConfig;
  /** agentskills.io import bridge. */
  agentskills?: SkillsAgentskillsConfig;
  /** External skill generation via Skill Seekers. */
  skillSeekers?: SkillSeekersConfig;
  /** PLAN-11 Gap 4: LLM-based marketability prediction (opt-in). */
  marketability?: {
    predictor?: {
      /** Enable the predictor. Default: false. */
      enabled?: boolean;
      /** Max predictions per dream cycle. Default: 10. */
      maxPerCycle?: number;
      /** Days to cache predictions before re-predicting. Default: 30. */
      predictionTtlDays?: number;
      /** Max influence on skill pricing as a multiplier (0-1). Default: 0.2. */
      pricingInfluence?: number;
      /** Blending weight in refiner scores (0-1). Default: 0.2. */
      refinerBlendWeight?: number;
      /** Model spec "provider/model" for prediction. */
      model?: string;
    };
  };
};
