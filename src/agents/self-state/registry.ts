/**
 * The parts of the agent it should know the state of, and how to read each
 * one's state. Every `read` goes through the function the part itself calls
 * to decide whether to run (src/config/feature-switches.ts, or the part's own
 * resolver), so the agent's account matches what runs. Adding a part: add its
 * switch where the part decides, call it from both places, and add the entry
 * here; self-state.test.ts checks that its keys exist in the config schema.
 */

import { resolveBrowserConfig } from "../../browser/config.js";
import {
  a2aEnabled,
  architectCycleEnabled,
  architectRulesEnabled,
  autoResearchEnabled,
  canonicalLedgerEnabled,
  circlesEnabled,
  computeEnabled,
  conversationMemoryEnabled,
  correctionCaptureEnabled,
  curiosityEnabled,
  dreamBriefEnabled,
  dreamEngineEnabled,
  forageNightShiftEnabled,
  harnessEvolveEnabled,
  marketabilityPredictorEnabled,
  monitorsEnabled,
  p2pEnabled,
  paidComputeEnabled,
  skillCuratorEnabled,
  skillEvolutionEnabled,
  skillPropagationEnabled,
  skillSeekersEnabled,
  walletCredentialsPresent,
  walletToolEnabled,
  x402Enabled,
} from "../../config/feature-switches.js";
import { resolveCuriosityResearchConfig } from "../../memory/curiosity-researcher.js";
import { mergeDreamModeConfigs, type DreamMode } from "../../memory/dream-types.js";
import { resolveEvidenceConfig } from "../../memory/evidence-telemetry.js";
import { resolveSurfacingTrialConfig } from "../../memory/surfacing-trial.js";
import { resolveDefaultAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import {
  resolveSkillPriorEvidence,
  resolveSkillPriorMode,
  resolveSkillPriorWriterMode,
} from "../skills/skill-prior.js";
import { resolveFetchConfig, resolveFetchEnabled } from "../tools/web-fetch.js";
import {
  isWebSearchConfigured,
  resolveSearchConfig,
  resolveSearchEnabled,
} from "../tools/web-search.js";
import type { Capability, CapabilityReading } from "./types.js";

const SILENT = { debug: () => {}, warn: () => {} };

const onOff = (on: boolean): CapabilityReading => ({ state: on ? "on" : "off" });

/** On, but only as far as the parts it depends on are on. */
function within(parentOn: boolean, reading: CapabilityReading): CapabilityReading {
  return parentOn ? reading : { state: "off" };
}

const DREAM_MODE_LABELS: Record<DreamMode, { label: string; does: string }> = {
  replay: { label: "replay dreams", does: "Re-runs important recent memories to strengthen them." },
  compression: {
    label: "compression dreams",
    does: "Merges overlapping memories into more general ones.",
  },
  simulation: {
    label: "simulation dreams",
    does: "Combines ideas from unrelated areas; results come back as dream hypotheses.",
  },
  extrapolation: {
    label: "extrapolation dreams",
    does: "Projects patterns forward; results come back as dream hypotheses.",
  },
  exploration: {
    label: "exploration dreams",
    does: "Reflects on the edges of what you know, inside memory (no web).",
  },
  interceptor_harvest: {
    label: "interceptor harvest",
    does: "Mines past guardrail firings to propose new guardrails.",
  },
  relationship_reconsolidation: {
    label: "belief reconsolidation",
    does: "Settles flagged contradictions between beliefs about people and things.",
  },
  harness_evolve: {
    label: "harness evolution dreams",
    does: "Mines harness-level failures and proposes validated policy edits.",
  },
  relationship_mining: {
    label: "relationship mining",
    does: "Extracts who-is-who links from facts into the knowledge graph.",
  },
  canonical_promotion: {
    label: "canonical promotion",
    does: "Promotes stable facts into the settled-facts ledger.",
  },
  hygiene: {
    label: "memory hygiene",
    does: "Backfills missing embeddings and raises questions about stale facts.",
  },
  distillation: {
    label: "workflow distillation",
    does: "Turns verified successful runs into reusable workflows.",
  },
  anticipation: {
    label: "anticipation briefs",
    does: "Prepares short briefs for questions you are likely to be asked next.",
  },
};

const dreamModeCapabilities: Capability[] = (Object.keys(DREAM_MODE_LABELS) as DreamMode[]).map(
  (mode) => ({
    id: `dream.${mode}`,
    area: "dreams",
    label: DREAM_MODE_LABELS[mode].label,
    does: DREAM_MODE_LABELS[mode].does,
    keys: [`memory.dream.modes.${mode}.enabled`],
    read: ({ config }) => {
      const modes = mergeDreamModeConfigs(config.memory?.dream?.modes);
      let on = dreamEngineEnabled(config.memory?.dream) && modes[mode].enabled;
      if (mode === "harness_evolve") {
        on = on && harnessEvolveEnabled(config.agents?.defaults?.harnessEvolve);
      }
      return onOff(on);
    },
  }),
);

export const CAPABILITIES: readonly Capability[] = [
  // ---- memory ----
  {
    id: "memory.search",
    area: "memory",
    label: "memory search",
    does: "Searches what you remember: settled facts first, then meaning, keywords and the knowledge graph fused together.",
    keys: ["agents.defaults.memorySearch.enabled"],
    read: ({ config, env }) => {
      if (env.BITTERBOT_MEMORY_OFF === "1") {
        return { state: "off" };
      }
      return onOff(resolveMemorySearchConfig(config, resolveDefaultAgentId(config)) !== null);
    },
  },
  {
    id: "memory.conversations",
    area: "memory",
    label: "conversation memory",
    does: "Indexes your conversations so earlier exchanges can be recalled, and extracts facts from them.",
    keys: ["session.memory"],
    read: ({ config }) => onOff(conversationMemoryEnabled(config.session)),
  },
  {
    id: "memory.canonical",
    area: "memory",
    label: "settled-facts ledger",
    does: "Keeps pinned and corroborated facts that outrank anything learned in the background.",
    keys: ["memory.canonicalLedger.enabled"],
    read: ({ config }) => onOff(canonicalLedgerEnabled(config.memory?.canonicalLedger)),
  },
  {
    id: "memory.corrections",
    area: "memory",
    label: "correction capture",
    does: "Notices when the owner corrects you and records the correction as a settled fact.",
    keys: ["memory.correction.enabled"],
    read: ({ config }) =>
      within(
        conversationMemoryEnabled(config.session) &&
          canonicalLedgerEnabled(config.memory?.canonicalLedger),
        onOff(correctionCaptureEnabled(config.memory?.correction)),
      ),
  },
  // ---- dreams ----
  {
    id: "dream.engine",
    area: "dreams",
    label: "dream engine",
    does: "Runs dream cycles while you are idle and rewrites MEMORY.md.",
    keys: ["memory.dream.enabled"],
    read: ({ config }) => onOff(dreamEngineEnabled(config.memory?.dream)),
  },
  ...dreamModeCapabilities,
  {
    id: "dream.brief",
    area: "dreams",
    label: "daily dream brief",
    does: "Sends the owner a short note of what you dreamed.",
    keys: ["memory.dreamBrief.enabled"],
    read: ({ config }) =>
      within(
        dreamEngineEnabled(config.memory?.dream),
        onOff(dreamBriefEnabled(config.memory?.dreamBrief)),
      ),
  },
  // ---- curiosity ----
  {
    id: "curiosity.engine",
    area: "curiosity",
    label: "curiosity engine",
    does: "Scores new memories for novelty and surprise and keeps a list of questions and gaps.",
    keys: ["memory.curiosity.enabled"],
    read: ({ config }) => onOff(curiosityEnabled(config.memory?.curiosity)),
  },
  {
    id: "curiosity.research",
    area: "curiosity",
    label: "curiosity research",
    does: "Takes one generic question at a time, searches the web, and keeps an answer only when two sources agree.",
    keys: ["memory.curiosity.research.enabled", "memory.curiosity.autoResearch.enabled"],
    read: ({ config }) => {
      const curiosity = config.memory?.curiosity;
      const on = resolveCuriosityResearchConfig(
        curiosity?.research,
        curiosity?.autoResearch?.enabled,
      ).enabled;
      if (!curiosityEnabled(curiosity) || !on) {
        return { state: "off" };
      }
      return isWebSearchConfigured(config)
        ? { state: "on" }
        : { state: "blocked", missing: "a web search API key" };
    },
  },
  {
    id: "curiosity.autoResearch",
    area: "curiosity",
    label: "dream research step",
    does: "Lets exploration dreams run a Skill Seekers research step with a local model.",
    keys: ["memory.curiosity.autoResearch.enabled"],
    read: ({ config }) => onOff(autoResearchEnabled(config.memory?.curiosity?.autoResearch)),
  },
  {
    id: "curiosity.evidence",
    area: "curiosity",
    label: "recall and surfacing telemetry",
    does: "Records which memories searches return and whether what you volunteer gets used; changes nothing.",
    keys: ["memory.curiosity.evidence.mode"],
    read: ({ config }) => {
      const mode = resolveEvidenceConfig(config.memory?.curiosity?.evidence, SILENT).mode;
      return mode === "off" ? { state: "off" } : { state: "recording", mode };
    },
  },
  {
    id: "curiosity.surfacingTrial",
    area: "curiosity",
    label: "surfacing trial",
    does: "Records eligibility and assignment for a future trial of what you volunteer; withholds nothing.",
    keys: ["memory.curiosity.evidence.surfacingTrial.mode"],
    read: ({ config }) => {
      const evidence = config.memory?.curiosity?.evidence;
      const evidenceOn = resolveEvidenceConfig(evidence, SILENT).mode !== "off";
      const trial = resolveSurfacingTrialConfig(evidence?.surfacingTrial, SILENT).mode;
      return evidenceOn && trial !== "off" ? { state: "recording", mode: trial } : { state: "off" };
    },
  },
  // ---- skills ----
  {
    id: "skills.evolution",
    area: "skills",
    label: "skill evolution",
    does: "Proposes new or changed skills from your runs; only gated, validated ones go live.",
    keys: ["skills.evolution.enabled"],
    read: ({ config }) =>
      within(
        dreamEngineEnabled(config.memory?.dream),
        onOff(skillEvolutionEnabled(config.skills?.evolution)),
      ),
  },
  {
    id: "skills.propagate",
    area: "skills",
    label: "skill sharing with peers",
    does: "Publishes promoted skills to the P2P network after their maturity window.",
    keys: ["skills.evolution.propagate"],
    read: ({ config }) => {
      if (
        !skillEvolutionEnabled(config.skills?.evolution) ||
        !skillPropagationEnabled(config.skills?.evolution)
      ) {
        return { state: "off" };
      }
      return p2pEnabled(config)
        ? { state: "on" }
        : { state: "blocked", missing: "the P2P network" };
    },
  },
  {
    id: "skills.curator",
    area: "skills",
    label: "skill curator",
    does: "Archives, patches or merges skills you made, based on use and errors.",
    keys: ["memory.dream.skillCurator.enabled"],
    read: ({ config }) =>
      within(
        dreamEngineEnabled(config.memory?.dream),
        onOff(skillCuratorEnabled(config.memory?.dream?.skillCurator)),
      ),
  },
  {
    id: "skills.prior",
    area: "skills",
    label: "experience-guided skill order",
    does: "Orders the skills index by verified outcomes recorded on this node.",
    keys: ["skills.prior.enabled", "skills.prior.mode"],
    read: ({ config }) => {
      const mode = resolveSkillPriorMode(config.skills?.prior);
      return mode === "off" ? { state: "off" } : { state: "on", mode };
    },
  },
  {
    id: "skills.priorEvidence",
    area: "skills",
    label: "experience notes on skills",
    does: "Shows the verified outcomes beside a skill in your index.",
    keys: ["skills.prior.evidence"],
    read: ({ config }) => {
      const style = resolveSkillPriorEvidence(config.skills?.prior);
      return style === "off" ? { state: "off" } : { state: "on", mode: style };
    },
  },
  {
    id: "skills.priorWriter",
    area: "skills",
    label: "verified-outcome recording",
    does: "Records verified skill outcomes from real runs into the ledger the skill order reads.",
    keys: ["skills.prior.writer"],
    read: ({ config }) => {
      const mode = resolveSkillPriorWriterMode(config.skills?.prior);
      if (mode === "off") {
        return { state: "off" };
      }
      return mode === "shadow" ? { state: "recording", mode } : { state: "on" };
    },
  },
  {
    id: "skills.seekers",
    area: "skills",
    label: "Skill Seekers",
    does: "Builds skills from documentation sites and repositories on request.",
    keys: ["skills.skillSeekers.enabled"],
    read: ({ config }) => onOff(skillSeekersEnabled(config.skills?.skillSeekers)),
  },
  {
    id: "skills.marketability",
    area: "skills",
    label: "skill marketability predictor",
    does: "Estimates which of your skills other agents would want.",
    keys: ["skills.marketability.predictor.enabled"],
    read: ({ config }) =>
      onOff(marketabilityPredictorEnabled(config.skills?.marketability?.predictor)),
  },
  {
    id: "skills.harnessEvolve",
    area: "skills",
    label: "harness evolution",
    does: "Proposes, validates and promotes edits to your own working loop.",
    keys: ["agents.defaults.harnessEvolve.enabled"],
    read: ({ config }) => onOff(harnessEvolveEnabled(config.agents?.defaults?.harnessEvolve)),
  },
  {
    id: "memory.architect",
    area: "memory",
    label: "memory architect",
    does: "Learns rules for what to extract and remember; the rules apply only when switched on explicitly.",
    keys: ["memory.architectEvolution.enabled"],
    read: ({ config }) => {
      const architect = config.memory?.architectEvolution;
      if (!architectCycleEnabled(architect)) {
        return { state: "off" };
      }
      return architectRulesEnabled(architect)
        ? { state: "on" }
        : { state: "recording", mode: "learning rules, not applying them" };
    },
  },
  // ---- network ----
  {
    id: "network.p2p",
    area: "network",
    label: "P2P network",
    does: "Connects you to other Bitterbot agents to exchange skills and telemetry.",
    keys: ["p2p.enabled"],
    read: ({ config }) => onOff(p2pEnabled(config)),
  },
  {
    id: "network.circles",
    area: "network",
    label: "circles",
    does: "Small trusted groups of agents that talk to each other.",
    keys: ["circles.enabled"],
    read: ({ config }) => onOff(circlesEnabled(config)),
  },
  {
    id: "network.a2a",
    area: "network",
    label: "A2A endpoint",
    does: "Lets external agents discover and hire you over the Agent2Agent protocol.",
    keys: ["a2a.enabled"],
    read: ({ config }) => onOff(a2aEnabled(config)),
  },
  {
    id: "network.forageNightShift",
    area: "network",
    label: "Forage night shift",
    does: "Hunts paid bounties while the owner is away.",
    keys: ["forage.nightShift.enabled"],
    read: ({ config }) => onOff(forageNightShiftEnabled(config.forage?.nightShift)),
  },
  {
    id: "network.wallet",
    area: "network",
    label: "wallet",
    does: "Your USDC wallet on Base: balances, sending and receiving.",
    keys: ["tools.wallet.enabled"],
    read: ({ config, env }) => {
      const wallet = config.tools?.wallet;
      if (!walletToolEnabled(wallet)) {
        return { state: "off" };
      }
      return walletCredentialsPresent(wallet, env)
        ? { state: "on" }
        : { state: "blocked", missing: "Coinbase CDP credentials" };
    },
  },
  {
    id: "network.x402",
    area: "network",
    label: "x402 payments",
    does: "Pays for paywalled content automatically, within the owner's limits.",
    keys: ["tools.wallet.x402.enabled"],
    read: ({ config, env }) => {
      const wallet = config.tools?.wallet;
      if (!x402Enabled(wallet)) {
        return { state: "off" };
      }
      return walletCredentialsPresent(wallet, env)
        ? { state: "on" }
        : { state: "blocked", missing: "Coinbase CDP credentials" };
    },
  },
  {
    id: "network.compute",
    area: "network",
    label: "compute pools",
    does: "Runs jobs on shared GPU pools.",
    keys: ["compute.enabled"],
    read: ({ config }) => onOff(computeEnabled(config.compute)),
  },
  {
    id: "network.paidCompute",
    area: "network",
    label: "paid compute",
    does: "Pays for compute jobs, with owner approval and per-job and per-day caps.",
    keys: ["compute.paid.enabled"],
    read: ({ config }) =>
      within(computeEnabled(config.compute), onOff(paidComputeEnabled(config.compute))),
  },
  // ---- tools ----
  {
    id: "tools.webSearch",
    area: "tools",
    label: "web search",
    does: "Searches the web with the configured provider.",
    keys: ["tools.web.search.enabled"],
    read: ({ config }) => {
      if (!resolveSearchEnabled({ search: resolveSearchConfig(config) })) {
        return { state: "off" };
      }
      return isWebSearchConfigured(config)
        ? { state: "on" }
        : { state: "blocked", missing: "a web search API key" };
    },
  },
  {
    id: "tools.webFetch",
    area: "tools",
    label: "web fetch",
    does: "Reads a web page.",
    keys: ["tools.web.fetch.enabled"],
    read: ({ config }) => onOff(resolveFetchEnabled({ fetch: resolveFetchConfig(config) })),
  },
  {
    id: "tools.browser",
    area: "tools",
    label: "browser",
    does: "Drives a real browser.",
    keys: ["browser.enabled"],
    read: ({ config }) => onOff(resolveBrowserConfig(config.browser, config).enabled),
  },
  {
    id: "tools.monitors",
    area: "tools",
    label: "monitors",
    does: "Watches things on a schedule and tells the owner when they change.",
    keys: ["monitors.enabled"],
    read: ({ config, env }) => onOff(monitorsEnabled(config.monitors, env)),
  },
];
