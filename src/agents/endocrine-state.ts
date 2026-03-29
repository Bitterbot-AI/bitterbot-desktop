/**
 * Resolve the current endocrine state for system prompt injection.
 * Reads hormonal levels from the memory manager singleton and
 * phenotype summary from MEMORY.md.
 */

import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("endocrine");

export type EndocrineStateForPrompt = {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
  briefing: string;
  phenotypeSummary?: string;
  maturity?: number;
  /** Compact 1-line summary from the latest session handover brief */
  lastSessionBrief?: string;
  /** Proactive memory facts for involuntary recall (Plan 7, Phase 1) */
  proactiveMemories?: string;
  /** Intra-session coherence context (Plan 7, Phase 2+9) */
  sessionCoherence?: string;
};

export async function resolveEndocrineState(params: {
  config?: BitterbotConfig;
  agentId: string;
  workspaceDir: string;
}): Promise<EndocrineStateForPrompt | undefined> {
  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const manager = await MemoryIndexManager.get({
      cfg: params.config ?? {},
      agentId: params.agentId,
      purpose: "status",
    });
    if (!manager) return undefined;

    // Get hormonal state via the public hormonalState() method
    const hormones = manager.hormonalState();
    if (!hormones) return undefined;

    // Get response modulation briefing via the hormonal manager
    const hormonalMgr = (manager as Record<string, unknown>).hormonalManager as
      | { responseModulation(): { briefing: string } }
      | null;
    const briefing = hormonalMgr?.responseModulation().briefing ?? "";

    // Get maturity from GCCRF
    const diagnostics = manager.gccrfDiagnostics?.();
    const maturity = diagnostics?.maturity as number | undefined;

    // Get phenotype summary from MEMORY.md (extract first line of Phenotype section)
    let phenotypeSummary: string | undefined;
    try {
      const fsPromises = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const memoryMd = await fsPromises.readFile(
        pathMod.join(params.workspaceDir, "MEMORY.md"),
        "utf-8",
      );
      const phenoMatch = memoryMd.match(
        /## The Phenotype[^\n]*\n\*[^\n]*\*\n([^\n]+)/,
      );
      if (phenoMatch?.[1]) {
        phenotypeSummary = phenoMatch[1].slice(0, 200).trim();
      }
    } catch {
      // No MEMORY.md or no Phenotype section yet — that's fine
    }

    // Load latest session handover brief for cross-session continuity
    let lastSessionBrief: string | undefined;
    try {
      const { loadLatestHandoverBrief, formatCompactSummary } = await import("../memory/session-handover.js");
      const brief = await loadLatestHandoverBrief(params.workspaceDir);
      if (brief) {
        lastSessionBrief = formatCompactSummary(brief);
      }
    } catch {
      // No handover briefs yet — that's fine
    }

    // Plan 7, Phase 1: Proactive memory surfacing — involuntary recall of identity/directive facts
    let proactiveMemories: string | undefined;
    try {
      const { proactiveRecall, formatProactiveFacts } = await import("../memory/proactive-recall.js");
      const result = proactiveRecall({
        userMessage: "",  // Will be populated when called with context
        queryEmbedding: null,  // Identity prefs don't need embedding
        db: (manager as Record<string, unknown>).db as import("node:sqlite").DatabaseSync,
        userModelManager: (manager as Record<string, unknown>).userModelManager as import("../memory/user-model.js").UserModelManager | null,
        recentlySurfaced: (manager as Record<string, unknown>).proactiveRecallCooldown as Map<string, number> ?? new Map(),
        currentTurn: 0,
        hormonalModulation: hormonalMgr ? (hormonalMgr as unknown as { getRetrievalModulation(): { importanceBoost: number; recencyBias: number } }).getRetrievalModulation() : null,
      });
      if (result.facts.length > 0) {
        proactiveMemories = formatProactiveFacts(result.facts);
      }
    } catch {
      // Proactive recall not available — non-critical
    }

    // Plan 7, Phase 2+9: Session coherence — intra-session thread/intent tracking
    let sessionCoherence: string | undefined;
    try {
      const tracker = (manager as Record<string, unknown>).coherenceTracker as
        | { formatForPrompt(): string | null }
        | null;
      if (tracker) {
        sessionCoherence = tracker.formatForPrompt() ?? undefined;
      }
    } catch {
      // Coherence tracker not available — non-critical
    }

    return {
      dopamine: hormones.dopamine,
      cortisol: hormones.cortisol,
      oxytocin: hormones.oxytocin,
      briefing,
      phenotypeSummary,
      maturity,
      lastSessionBrief,
      proactiveMemories,
      sessionCoherence,
    };
  } catch (err) {
    log.debug(`Failed to resolve endocrine state: ${String(err)}`);
    return undefined;
  }
}
