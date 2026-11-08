/**
 * The parts of the agent it should know the state of, and how to read each
 * one's state. Every `read` goes through the function the part itself calls
 * to decide whether to run (src/config/feature-switches.ts, or the part's own
 * resolver), so the agent's account matches what runs. Adding a part: add its
 * switch where the part decides, call it from both places, and add the entry
 * here; self-state.test.ts checks that its keys exist in the config schema.
 *
 * A reading says what the settings switch on. Where the gateway can see
 * more (an owner pause, a missing backend, no peers), `ctx.observed`
 * carries it and the reading reports that instead; the system prompt block
 * reads settings only, the `self_state` tool adds the observations.
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
import {
  applyDreamModeKillSwitches,
  mergeDreamModeConfigs,
  type DreamMode,
} from "../../memory/dream-types.js";
import { resolveEvidenceConfig } from "../../memory/evidence-telemetry.js";
import { isLocalModelSpec } from "../../memory/local-model-spec.js";
import { resolveSurfacingTrialConfig } from "../../memory/surfacing-trial.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agent-scope.js";
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
import type { Capability, CapabilityContext, CapabilityReading } from "./types.js";

const SILENT = { debug: () => {}, warn: () => {} };

const onOff = (on: boolean): CapabilityReading => ({ state: on ? "on" : "off" });

type Parent = { on: boolean; label: string; keys: string[] };

/** On, but only as far as the parts it depends on are on; says which one is not. */
function within(parents: Parent[], reading: CapabilityReading): CapabilityReading {
  const off = parents.find((p) => !p.on);
  if (!off) {
    return reading;
  }
  return {
    state: "off",
    because: { kind: "parent", detail: `${off.label} is off`, keys: off.keys },
  };
}

const dreamEngine = (config: CapabilityContext["config"]): Parent => ({
  on: dreamEngineEnabled(config.memory?.dream),
  label: "the dream engine",
  keys: ["memory.dream.enabled"],
});

/** Dream modes after every switch that can silence them (the engine's own merge). */
function effectiveDreamModes(config: CapabilityContext["config"]) {
  return mergeDreamModeConfigs(applyDreamModeKillSwitches(config.memory?.dream?.modes, config));
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
      const parents = [dreamEngine(config)];
      if (mode === "canonical_promotion") {
        parents.push({
          on: canonicalLedgerEnabled(config.memory?.canonicalLedger),
          label: "the settled-facts ledger",
          keys: ["memory.canonicalLedger.enabled"],
        });
      }
      if (mode === "harness_evolve") {
        parents.push({
          on: harnessEvolveEnabled(config.agents?.defaults?.harnessEvolve),
          label: "harness evolution",
          keys: ["agents.defaults.harnessEvolve.enabled"],
        });
      }
      return within(parents, onOff(effectiveDreamModes(config)[mode].enabled));
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
    read: ({ config, env, agentId }) => {
      if (env.BITTERBOT_MEMORY_OFF === "1") {
        return {
          state: "off",
          because: {
            kind: "environment",
            detail: "turned off for this process by the environment",
            keys: ["BITTERBOT_MEMORY_OFF"],
          },
        };
      }
      // The agent taking the turn, with its own override (memory-tool.ts does the same).
      const id = agentId ?? resolveDefaultAgentId(config);
      const override = resolveAgentConfig(config, id)?.memorySearch?.enabled;
      const reading = onOff(resolveMemorySearchConfig(config, id) !== null);
      return override === undefined
        ? reading
        : { ...reading, controls: [`agents.list[${id}].memorySearch.enabled`], source: "config" };
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
        [
          {
            on: conversationMemoryEnabled(config.session),
            label: "conversation memory",
            keys: ["session.memory"],
          },
          {
            on: canonicalLedgerEnabled(config.memory?.canonicalLedger),
            label: "the settled-facts ledger",
            keys: ["memory.canonicalLedger.enabled"],
          },
        ],
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
    does: "Sends the owner a short daily note of what you dreamed and learned, when there is something worth sending.",
    keys: ["memory.dreamBrief.enabled"],
    // It rides the daily digest timer, not the dream engine (manager.ts).
    read: ({ config }) =>
      within(
        [
          {
            on: config.memory?.digest?.enabled !== false,
            label: "the daily digest",
            keys: ["memory.digest.enabled"],
          },
        ],
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
    read: ({ config, observed }) => {
      const curiosity = config.memory?.curiosity;
      const on = resolveCuriosityResearchConfig(
        curiosity?.research,
        curiosity?.autoResearch?.enabled,
      ).enabled;
      const reading = within(
        [
          {
            on: curiosityEnabled(curiosity),
            label: "the curiosity engine",
            keys: ["memory.curiosity.enabled"],
          },
        ],
        onOff(on),
      );
      if (reading.state === "off") {
        return reading;
      }
      if (observed?.curiosityPaused) {
        return {
          state: "paused",
          because: { kind: "observed", detail: "the owner paused curiosity research" },
        };
      }
      return isWebSearchConfigured(config)
        ? { state: "on" }
        : { state: "blocked", missing: "a configured web search provider" };
    },
  },
  {
    id: "curiosity.autoResearch",
    area: "curiosity",
    label: "dream research step",
    does: "Lets exploration dreams run a Skill Seekers research step with a local model.",
    keys: ["memory.curiosity.autoResearch.enabled"],
    // Runs inside exploration dreams, through the Skill Seekers adapter, and
    // fails closed without a genuinely local model (dream-engine.ts).
    read: ({ config }) => {
      const reading = within(
        [
          dreamEngine(config),
          {
            on: effectiveDreamModes(config).exploration.enabled,
            label: "exploration dreams",
            keys: ["memory.dream.modes.exploration.enabled"],
          },
          {
            on: skillSeekersEnabled(config.skills?.skillSeekers),
            label: "Skill Seekers",
            keys: ["skills.skillSeekers.enabled"],
          },
        ],
        onOff(autoResearchEnabled(config.memory?.curiosity?.autoResearch)),
      );
      if (reading.state !== "on") {
        return reading;
      }
      return isLocalModelSpec(config.memory?.dream?.modelTiers?.localModel)
        ? reading
        : { state: "blocked", missing: "a local model (memory.dream.modelTiers.localModel)" };
    },
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
      within([dreamEngine(config)], onOff(skillEvolutionEnabled(config.skills?.evolution))),
  },
  {
    id: "skills.propagate",
    area: "skills",
    label: "skill sharing with peers",
    does: "Publishes promoted skills to the P2P network after their maturity window.",
    keys: ["skills.evolution.propagate"],
    read: ({ config, observed }) => {
      const reading = within(
        [
          {
            on: skillEvolutionEnabled(config.skills?.evolution),
            label: "skill evolution",
            keys: ["skills.evolution.enabled"],
          },
        ],
        onOff(skillPropagationEnabled(config.skills?.evolution)),
      );
      if (reading.state === "off") {
        return reading;
      }
      if (!p2pEnabled(config)) {
        return { state: "blocked", missing: "the P2P network (p2p.enabled)" };
      }
      return observed?.p2pConnected === false
        ? { state: "blocked", missing: "a connected peer" }
        : reading;
    },
  },
  {
    id: "skills.curator",
    area: "skills",
    label: "skill curator",
    does: "Archives, patches or merges skills you made, based on use and errors.",
    keys: ["memory.dream.skillCurator.enabled"],
    read: ({ config }) =>
      within([dreamEngine(config)], onOff(skillCuratorEnabled(config.memory?.dream?.skillCurator))),
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
    does: "Proposes rules for what to extract and remember (model calls), validates them and stores the accepted ones; they change extraction only when set to true explicitly.",
    keys: ["memory.architectEvolution.enabled"],
    read: ({ config }) => {
      const architect = config.memory?.architectEvolution;
      if (!architectCycleEnabled(architect)) {
        return { state: "off" };
      }
      return architectRulesEnabled(architect)
        ? { state: "on", mode: "applying its rules" }
        : { state: "on", mode: "learning rules, not applying them yet" };
    },
  },
  // ---- network ----
  {
    id: "network.p2p",
    area: "network",
    label: "P2P network",
    does: "Connects you to other Bitterbot agents to exchange skills and telemetry.",
    keys: ["p2p.enabled"],
    read: ({ config, observed }) => {
      if (!p2pEnabled(config)) {
        return { state: "off" };
      }
      return observed?.p2pConnected === false
        ? { state: "blocked", missing: "a connection to the network (no peers right now)" }
        : { state: "on" };
    },
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
    // compute-tool.ts drops the tool without a backend, and read-only without a runtime.
    read: ({ config, observed }) => {
      if (!computeEnabled(config.compute)) {
        return { state: "off" };
      }
      switch (observed?.computeBackend) {
        case "none":
          return { state: "blocked", missing: "a registered compute backend" };
        case "read-only":
          return { state: "on", mode: "read-only, cannot submit jobs" };
        default:
          return { state: "on" };
      }
    },
  },
  {
    id: "network.paidCompute",
    area: "network",
    label: "paid compute",
    does: "Pays for compute jobs, with owner approval and per-job and per-day caps.",
    keys: ["compute.paid.enabled"],
    read: ({ config }) =>
      within(
        [{ on: computeEnabled(config.compute), label: "compute pools", keys: ["compute.enabled"] }],
        onOff(paidComputeEnabled(config.compute)),
      ),
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
        : { state: "blocked", missing: "a configured web search provider" };
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
    read: ({ config, env }) => {
      if (config.monitors?.enabled !== false && !monitorsEnabled(config.monitors, env)) {
        return {
          state: "off",
          because: {
            kind: "environment",
            detail: "turned off for this process by the environment",
            keys: ["BITTERBOT_SKIP_MONITORS"],
          },
        };
      }
      return onOff(monitorsEnabled(config.monitors, env));
    },
  },
];
