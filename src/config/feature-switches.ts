/**
 * One place for each on/off rule that used to be written inline at its point
 * of use. The part itself and the agent's self-state
 * (src/agents/self-state/registry.ts) both call these, so the agent's account
 * of what is running cannot drift from what runs.
 *
 * Each takes the config block it reads, the same shape the call site had in
 * hand, and states its unset default in its name or doc.
 */

import { isTruthyEnvValue } from "../infra/env.js";
import type { BitterbotConfig } from "./config.js";

type Toggle = { enabled?: boolean } | undefined | null;

/** Dream engine: on unless `memory.dream.enabled` is false. */
export function dreamEngineEnabled(dream: Toggle): boolean {
  return dream?.enabled !== false;
}

/** Daily dream brief: on unless `memory.dreamBrief.enabled` is false. */
export function dreamBriefEnabled(brief: Toggle): boolean {
  return brief?.enabled !== false;
}

/** Curiosity engine and its tools: on unless `memory.curiosity.enabled` is false. */
export function curiosityEnabled(curiosity: Toggle): boolean {
  return curiosity?.enabled !== false;
}

/**
 * The dream engine's Skill Seekers research step: off unless
 * `memory.curiosity.autoResearch.enabled` is true.
 */
export function autoResearchEnabled(autoResearch: Toggle): boolean {
  return autoResearch?.enabled === true;
}

/** Harness evolution: off unless `agents.defaults.harnessEvolve.enabled` is true. */
export function harnessEvolveEnabled(harnessEvolve: Toggle): boolean {
  return harnessEvolve?.enabled === true;
}

/** Memory-architect evolve cycle: on unless `memory.architectEvolution.enabled` is false. */
export function architectCycleEnabled(architect: Toggle): boolean {
  return architect?.enabled !== false;
}

/**
 * Injecting the architect's learned rules into extraction: off unless
 * `memory.architectEvolution.enabled` is true.
 */
export function architectRulesEnabled(architect: Toggle): boolean {
  return architect?.enabled === true;
}

/** Skill evolution: on unless `skills.evolution.enabled` is false. */
export function skillEvolutionEnabled(evolution: Toggle): boolean {
  return evolution?.enabled !== false;
}

/** Publishing promoted skills to peers: on unless `skills.evolution.propagate` is false. */
export function skillPropagationEnabled(evolution: { propagate?: boolean } | undefined): boolean {
  return evolution?.propagate !== false;
}

/** Skill curator: on unless `memory.dream.skillCurator.enabled` is false. */
export function skillCuratorEnabled(curator: Toggle): boolean {
  return curator?.enabled !== false;
}

/** Skill Seekers tool and sweep: off unless `skills.skillSeekers.enabled` is true. */
export function skillSeekersEnabled(skillSeekers: Toggle): boolean {
  return skillSeekers?.enabled === true;
}

/**
 * Marketability predictor: off unless `skills.marketability.predictor.enabled`
 * is true.
 */
export function marketabilityPredictorEnabled(predictor: Toggle): boolean {
  return predictor?.enabled === true;
}

/** Settled-facts (canonical) ledger: on unless `memory.canonicalLedger.enabled` is false. */
export function canonicalLedgerEnabled(ledger: Toggle): boolean {
  return ledger?.enabled !== false;
}

/** Correction capture: on unless `memory.correction.enabled` is false. */
export function correctionCaptureEnabled(correction: Toggle): boolean {
  return correction?.enabled !== false;
}

/** Conversation memory: on unless `session.memory` is "off". */
export function conversationMemoryEnabled(session: { memory?: string } | undefined): boolean {
  return session?.memory !== "off";
}

/** Agent wallet tool: off unless `tools.wallet.enabled` is true. */
export function walletToolEnabled(wallet: Toggle): boolean {
  return wallet?.enabled === true;
}

/** x402 payments: off unless `tools.wallet.x402.enabled` is true (and the wallet is on). */
export function x402Enabled(wallet: { enabled?: boolean; x402?: Toggle } | undefined): boolean {
  return walletToolEnabled(wallet) && wallet?.x402?.enabled === true;
}

/**
 * The Coinbase CDP credentials the wallet needs: key id and secret (config or
 * env) plus CDP_WALLET_SECRET. Without them the wallet cannot start.
 */
export function walletCredentialsPresent(
  wallet: { cdpApiKeyId?: string; cdpApiKeySecret?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    (wallet?.cdpApiKeyId ?? env.CDP_API_KEY_ID) &&
    (wallet?.cdpApiKeySecret ?? env.CDP_API_KEY_SECRET) &&
    env.CDP_WALLET_SECRET,
  );
}

/** Compute pools: on unless `compute.enabled` is false. */
export function computeEnabled(compute: Toggle): boolean {
  return compute?.enabled !== false;
}

/** Paying for compute: off unless `compute.paid.enabled` is true. */
export function paidComputeEnabled(compute: { paid?: Toggle } | undefined): boolean {
  return compute?.paid?.enabled === true;
}

/** Forage night shift: off unless `forage.nightShift.enabled` is true. */
export function forageNightShiftEnabled(nightShift: Toggle): boolean {
  return nightShift?.enabled === true;
}

/** Monitors: on unless `monitors.enabled` is false or BITTERBOT_SKIP_MONITORS is truthy. */
export function monitorsEnabled(monitors: Toggle, env: NodeJS.ProcessEnv = process.env): boolean {
  return monitors?.enabled !== false && !isTruthyEnvValue(env.BITTERBOT_SKIP_MONITORS);
}

/**
 * P2P, circles and A2A get their defaults at load time (defaults.ts), so a
 * loaded config already carries them; these read the loaded value the way
 * the gateway does at startup.
 */
export function p2pEnabled(cfg: BitterbotConfig): boolean {
  return Boolean(cfg.p2p?.enabled);
}

export function circlesEnabled(cfg: BitterbotConfig): boolean {
  return cfg.circles?.enabled === true;
}

export function a2aEnabled(cfg: BitterbotConfig): boolean {
  return cfg.a2a?.enabled === true;
}
