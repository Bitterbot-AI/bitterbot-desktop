import type { Skill } from "@mariozechner/pi-coding-agent";

export type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type SkillOrigin = {
  /** Registry the skill was imported from, e.g. "agentskills.io". */
  registry?: string;
  /** Registry-side identifier for the skill. */
  slug?: string;
  /** Upstream version string, if advertised. */
  version?: string;
  /** SPDX license identifier reported by upstream. */
  license?: string;
  /** Direct URL to the upstream source (SKILL.md or repo page). */
  upstreamUrl?: string;
};

/**
 * PLAN-13 Phase B: declarative capability surface for skills.
 *
 * Each axis is independently negotiated. Absent fields are not auto-granted;
 * the profile resolver fills them with the trust-tier default for the
 * publisher (`verified` honors declarations, `provisional` strict-profile,
 * etc.). Operator grants are persisted in `skill_capability_grants` and
 * override defaults but never weaken explicit denies.
 *
 * Network/fs accept either `false` (deny axis entirely) or a structured
 * scope. The `${SKILL_WORKSPACE}` placeholder in fs paths resolves to the
 * skill's own baseDir at enforcement time.
 */
export type SkillCapabilitiesDeclaration = {
  /** Outbound network access. `false` = deny; object = host allowlist. */
  network?: false | { outbound?: string[] };
  /** Filesystem access. `false` = sandbox only (workspace read+write implicit). */
  fs?: false | { read?: string[]; write?: string[] };
  /** Wallet operations (USDC on Base). High-risk; first invocation prompts. */
  wallet?: boolean;
  /** Shell / arbitrary command execution. High-risk; first invocation prompts. */
  shell?: boolean;
  /** Sub-process spawn (separate from shell since it's lower-level). */
  process?: boolean;
};

export type BitterbotSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
  /** Provenance for imported/derived skills. Gates marketplace promotion. */
  origin?: SkillOrigin;
  /**
   * Phase B: declared capability surface. Required for skills ingested
   * from the P2P mesh; locally-authored skills can omit it and inherit the
   * `verified` (full-trust) default.
   */
  capabilities?: SkillCapabilitiesDeclaration;
};

export type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

export type SkillCommandDispatchSpec = {
  kind: "tool";
  /** Name of the tool to invoke (AnyAgentTool.name). */
  toolName: string;
  /**
   * How to forward user-provided args to the tool.
   * - raw: forward the raw args string (no core parsing).
   */
  argMode?: "raw";
};

export type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string;
  /** Optional deterministic dispatch behavior for this command. */
  dispatch?: SkillCommandDispatchSpec;
};

export type SkillsInstallPreferences = {
  preferBrew: boolean;
  nodeManager: "npm" | "pnpm" | "yarn" | "bun";
};

export type ParsedSkillFrontmatter = Record<string, string>;

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: BitterbotSkillMetadata;
  invocation?: SkillInvocationPolicy;
};

export type SkillEligibilityContext = {
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

export type SkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};

export type CrystallizationCandidate = {
  taskName: string;
  description: string;
  reasoningPath: string[];
  toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
  rewardScore: number;
  sessionKey: string;
  timestamp: number;
  /** Upstream provenance (present when this crystal descends from an imported skill). */
  origin?: SkillOrigin;
  /**
   * Degree of transformation over the upstream source (0-1). Required for marketplace
   * promotion of derivatives; gates P2P publish when origin.registry is set.
   */
  transformScore?: number;
};
