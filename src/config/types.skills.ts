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
  /** Ingestion policy for skills received via P2P. Default: "review" (quarantine for operator review). */
  ingestPolicy?: "auto" | "review" | "deny";
  /** Trusted peer public keys (base64 Ed25519) that bypass quarantine in auto mode. */
  trustList?: string[];
  /** Directory for quarantined incoming skills. */
  quarantineDir?: string;
  /** Maximum skills ingested per hour. Default: 20. */
  maxIngestedPerHour?: number;
  /**
   * PLAN-13 Phase A: prompt-injection scanner mode for inbound skill content.
   * - "regex" (default): rule-based scan; force-quarantines on critical hits.
   * - "off": skip scanning (not recommended; transport-layer crypto only).
   * The "classifier" mode is reserved for Phase C.
   */
  injectionScanner?: "regex" | "off";
  /**
   * PLAN-13 Phase C: TTL in days for quarantined skills. After this
   * window, the sweeper auto-rejects without operator action. Default 30.
   * Set to 0 to disable auto-rejection (skills accumulate forever).
   */
  quarantineTtlDays?: number;
  /**
   * PLAN-42: auto-reject unvalidated machine-generated crystals from the
   * legacy auto-publish pipeline instead of quarantining them for review.
   * Skills carrying wiki-evolution validation evidence still quarantine
   * normally. Default: true.
   */
  rejectLegacyCrystals?: boolean;
  /**
   * PLAN-29 Phase 0.3: load-time capability gate for P2P-ingested skills.
   * When true (default), workspace skill snapshots exclude P2P skills whose
   * declared capabilities exceed their publisher's trust tier plus operator
   * grants (PLAN-13 Phase B machinery). Runtime dispatch enforcement is a
   * separate concern and remains off. Set false to restore ungated loading.
   */
  loadTimeCapabilityGate?: boolean;
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
  /** API key for upload (uses agentskills.io's API). Read at upload time only. */
  apiKey?: string;
};

import type { SkillSeekersConfig } from "./types.skill-seekers.js";

/**
 * PLAN-42: WikiSkill-style skill evolution — consolidates execution traces
 * into a persistent wiki (CONFIG_DIR/skill-wiki/) and proposes gated skill
 * improvements. ON BY DEFAULT; the loop no-ops cleanly when no usable
 * background model is available and never touches the runtime prompt path.
 */
export type SkillsEvolutionConfig = {
  /** Master kill switch for the evolution loop. Default: true. */
  enabled?: boolean;
  /** Minimum hours between evolution iterations. Default: 24. */
  cadenceHours?: number;
  /** Max ReAct turns for the Skill Proposer agent. Default: 24. */
  maxProposerTurns?: number;
  /** Cap on concurrently-active evolved skills. Default: 5. */
  maxActiveEvolved?: number;
  /**
   * Validation gate mode. "records": LLM-scored paired comparison over
   * reconstructed held-out trajectories (bootstrap ci95Low > 0). "tasks":
   * hermetic rollouts over the replayable task corpus. Default: "records"
   * until a corpus exists on the node, then "tasks".
   */
  validationMode?: "records" | "tasks";
  /** Model spec "provider/model" for maintainer/labeler calls. Default: cheap-model resolution. */
  judgeModel?: string;
  /**
   * Model spec for the Skill Proposer ReAct agent. The proposer must hold a
   * strict JSON tool protocol over many turns; a stronger model than the
   * cheap maintainer lane pays off. Default: judgeModel, else cheap-model.
   */
  proposerModel?: string;
  /** Wiki pattern-page count that triggers the lint/archive pass. Default: 100. */
  wikiMaxPatterns?: number;
  /** Minimum days between semantic (LLM) wiki lint passes. Default: 7. */
  semanticLintCadenceDays?: number;
  /**
   * Publish validated + matured evolved skills to the P2P network with
   * their validation evidence (the flywheel's outbound leg). Default: true.
   */
  propagate?: boolean;
  /** Days a validated skill must survive locally before P2P publish. Default: 3. */
  maturityDays?: number;
};

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
  /** PLAN-42: WikiSkill evolution loop (on by default). */
  evolution?: SkillsEvolutionConfig;
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
