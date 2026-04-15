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

import type { SkillSeekersConfig } from "./types.skill-seekers.js";

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  entries?: Record<string, SkillConfig>;
  /** P2P skill ingestion settings. */
  p2p?: SkillsP2pConfig;
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
