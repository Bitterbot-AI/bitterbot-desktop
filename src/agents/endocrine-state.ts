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
    const hormonalMgr = (manager as Record<string, unknown>).hormonalManager as {
      responseModulation(): { briefing: string };
    } | null;
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
      const phenoMatch = memoryMd.match(/## The Phenotype[^\n]*\n\*[^\n]*\*\n([^\n]+)/);
      if (phenoMatch?.[1]) {
        phenotypeSummary = phenoMatch[1].slice(0, 200).trim();
      }
    } catch {
      // No MEMORY.md or no Phenotype section yet — that's fine
    }

    // Load latest session handover brief for cross-session continuity
    // Session Continuity Gate: only inject if the brief is relevant to the current context.
    // Below the entropy threshold → fresh start, skip the brief entirely.
    let lastSessionBrief: string | undefined;
    try {
      const { loadLatestHandoverBrief, formatCompactSummary } =
        await import("../memory/session-handover.js");
      const brief = await loadLatestHandoverBrief(params.workspaceDir);
      if (brief) {
        let gatePass = true;

        // Entropy gate: cosine similarity between brief purpose and user's first message.
        // If the user is doing something completely unrelated, skip the handover.
        try {
          const memManager = manager as Record<string, unknown>;
          const provider = memManager.provider as
            | { embedQuery?: (text: string) => Promise<number[]> }
            | undefined;
          if (provider?.embedQuery) {
            const { cosineSimilarity } = await import("../memory/internal.js");
            const briefEmb = await provider.embedQuery(brief.purpose);
            // Use the most recent user message or session context for comparison.
            // If no user message available yet (cold start), let the brief through.
            const recentQuery = brief.nextSteps?.[0] ?? brief.purpose;
            const contextEmb = await provider.embedQuery(recentQuery);
            // Only gate if embeddings are valid
            if (briefEmb.length > 0 && contextEmb.length > 0) {
              const similarity = cosineSimilarity(briefEmb, contextEmb);
              // Threshold 0.25: low enough that related topics pass, high enough to catch
              // "database migration" vs "birthday message" (typically ~0.05-0.10)
              if (similarity < 0.25) {
                gatePass = false;
                log.debug("session continuity gate: brief skipped (fresh start)", {
                  similarity: similarity.toFixed(3),
                  briefPurpose: brief.purpose.slice(0, 60),
                });
              }
            }
          }
        } catch {
          // Gate check failed — let the brief through (fail-open)
        }

        if (gatePass) {
          lastSessionBrief = formatCompactSummary(brief);

          // Staleness annotation for old briefs
          const ageHours = (Date.now() - brief.timestamp) / (60 * 60 * 1000);
          if (ageHours > 48) {
            lastSessionBrief = `(${Math.floor(ageHours / 24)}d ago) ${lastSessionBrief}`;
          }
        }
      }
    } catch {
      // No handover briefs yet — that's fine
    }

    // Plan 7, Phase 1: Proactive memory surfacing — involuntary recall of identity/directive facts
    let proactiveMemories: string | undefined;
    try {
      const { proactiveRecall, formatProactiveFacts } =
        await import("../memory/proactive-recall.js");
      const result = proactiveRecall({
        userMessage: "", // Will be populated when called with context
        queryEmbedding: null, // Identity prefs don't need embedding
        db: (manager as Record<string, unknown>).db as import("node:sqlite").DatabaseSync,
        userModelManager: (manager as Record<string, unknown>).userModelManager as
          | import("../memory/user-model.js").UserModelManager
          | null,
        recentlySurfaced:
          ((manager as Record<string, unknown>).proactiveRecallCooldown as Map<string, number>) ??
          new Map(),
        currentTurn: 0,
        hormonalModulation: hormonalMgr
          ? (
              hormonalMgr as unknown as {
                getRetrievalModulation(): { importanceBoost: number; recencyBias: number };
              }
            ).getRetrievalModulation()
          : null,
      });
      if (result.facts.length > 0) {
        proactiveMemories = formatProactiveFacts(result.facts);
      }
    } catch {
      // Proactive recall not available — non-critical
    }

    // PLAN-9: Prospective Memory — check triggers against current context
    try {
      const prospectiveEngine = (manager as Record<string, unknown>).prospectiveMemoryEngine as {
        checkTriggers(params: {
          messageText: string;
          messageEmbedding?: number[];
        }): Array<{ action: string }>;
      } | null;
      if (prospectiveEngine) {
        const triggered = prospectiveEngine.checkTriggers({ messageText: "" });
        if (triggered.length > 0) {
          const prospectiveLines = triggered.map((t) => `- [reminder] ${t.action}`);
          proactiveMemories = (proactiveMemories ?? "") + "\n" + prospectiveLines.join("\n");
        }
      }
    } catch {
      // Prospective memory not available — non-critical
    }

    // PLAN-9: Epistemic Directives — inject knowledge gap questions
    try {
      const epistemicEngine = (manager as Record<string, unknown>).epistemicDirectiveEngine as {
        getDirectivesForSession(): Array<{ question: string }>;
      } | null;
      if (epistemicEngine) {
        const directives = epistemicEngine.getDirectivesForSession();
        if (directives.length > 0) {
          const directiveLines = directives.map((d) => `- [question] ${d.question}`);
          proactiveMemories = (proactiveMemories ?? "") + "\n" + directiveLines.join("\n");
        }
      }
    } catch {
      // Epistemic directives not available — non-critical
    }

    // Plan 7, Phase 2+9: Session coherence — intra-session thread/intent tracking
    let sessionCoherence: string | undefined;
    try {
      const tracker = (manager as Record<string, unknown>).coherenceTracker as {
        formatForPrompt(): string | null;
      } | null;
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
