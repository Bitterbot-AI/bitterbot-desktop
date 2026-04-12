/**
 * Dream Engine Ablation Variants
 *
 * Each variant defines config overrides that selectively disable dream modes
 * or supporting subsystems. Deep-merged with the full biological baseline
 * config to produce a complete BitterbotConfig for each ablation run.
 */

export interface VariantConfig {
  id: string;
  name: string;
  description: string;
  /** What degradation we expect vs. full-bio baseline */
  expectedImpact: string;
  /** Deep-merged into the biological baseline's `memory` config */
  memoryOverrides: Record<string, unknown>;
}

/**
 * Mode overrides helper: disable specific dream modes by setting enabled: false.
 */
function disableModes(...modes: string[]): Record<string, { enabled: boolean }> {
  const overrides: Record<string, { enabled: boolean }> = {};
  for (const mode of modes) overrides[mode] = { enabled: false };
  return overrides;
}

function onlyModes(...modes: string[]): Record<string, { enabled: boolean }> {
  const all = [
    "replay",
    "compression",
    "mutation",
    "extrapolation",
    "simulation",
    "exploration",
    "research",
  ];
  const overrides: Record<string, { enabled: boolean }> = {};
  for (const mode of all) {
    overrides[mode] = { enabled: modes.includes(mode) };
  }
  return overrides;
}

export const VARIANTS: Record<string, VariantConfig> = {
  "full-bio": {
    id: "full-bio",
    name: "Full Biological Pipeline",
    description: "All dream modes and subsystems enabled (reference baseline)",
    expectedImpact: "N/A — this is the baseline",
    memoryOverrides: {},
  },

  "no-dreams": {
    id: "no-dreams",
    name: "No Dreams",
    description:
      "Dream engine completely disabled; consolidation and other subsystems still active",
    expectedImpact:
      "Multi-session reasoning and knowledge update accuracy should drop — no offline synthesis",
    memoryOverrides: {
      dream: { enabled: false },
    },
  },

  "replay-only": {
    id: "replay-only",
    name: "Replay Only",
    description: "Only replay mode (no LLM calls). Tests whether memory strengthening alone helps",
    expectedImpact:
      "Early-session fact retention should be better than no-dreams, but no cross-domain synthesis",
    memoryOverrides: {
      dream: {
        enabled: true,
        modes: onlyModes("replay"),
      },
    },
  },

  "compression-only": {
    id: "compression-only",
    name: "Compression Only",
    description: "Only compression mode (no LLM calls). Tests whether deduplication alone helps",
    expectedImpact: "Reduced chunk count may improve search precision; no insight generation",
    memoryOverrides: {
      dream: {
        enabled: true,
        modes: onlyModes("compression"),
      },
    },
  },

  "no-llm-modes": {
    id: "no-llm-modes",
    name: "No LLM Dream Modes",
    description:
      "Only replay + compression (free modes). Tests whether the zero-cost dream path is sufficient",
    expectedImpact: "Memory maintenance without creative synthesis — baseline for LLM mode value",
    memoryOverrides: {
      dream: {
        enabled: true,
        modes: onlyModes("replay", "compression"),
      },
    },
  },

  "no-simulation": {
    id: "no-simulation",
    name: "No Simulation Mode",
    description: "All modes except simulation. Tests whether cross-domain connections add value",
    expectedImpact: "Multi-session reasoning may degrade — simulation bridges disparate knowledge",
    memoryOverrides: {
      dream: {
        enabled: true,
        modes: disableModes("simulation"),
      },
    },
  },

  "no-extrapolation": {
    id: "no-extrapolation",
    name: "No Extrapolation Mode",
    description: "All modes except extrapolation. Tests whether predictive insights add value",
    expectedImpact: "Temporal reasoning may degrade — extrapolation anticipates future queries",
    memoryOverrides: {
      dream: {
        enabled: true,
        modes: disableModes("extrapolation"),
      },
    },
  },

  "no-curiosity": {
    id: "no-curiosity",
    name: "No Curiosity Engine",
    description:
      "Curiosity (GCCRF) disabled. Dream seeds chosen without curiosity-weighted importance",
    expectedImpact: "Worse seed selection for dreams, no gap detection, no exploration targets",
    memoryOverrides: {
      curiosity: { enabled: false },
    },
  },

  "no-hormonal": {
    id: "no-hormonal",
    name: "No Hormonal Modulation",
    description:
      "Hormonal system disabled. Dream mode selection uses flat temperature (no emotional influence)",
    expectedImpact: "Loss of mood-congruent retrieval and emotion-weighted dream prioritization",
    memoryOverrides: {
      emotional: {
        enabled: true,
        hormonal: { enabled: false },
      },
    },
  },

  "no-fsho": {
    id: "no-fsho",
    name: "No FSHO Oscillator",
    description:
      "FSHO disabled (uniform mode weights). Tests whether the oscillator adds signal or noise",
    expectedImpact:
      "If FSHO is noise, this should match or beat baseline. If signal, accuracy drops",
    memoryOverrides: {
      dream: {
        enabled: true,
        disableFsho: true,
      },
    },
  },
};

export const VARIANT_IDS = Object.keys(VARIANTS);
