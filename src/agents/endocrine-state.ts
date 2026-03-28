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

    return {
      dopamine: hormones.dopamine,
      cortisol: hormones.cortisol,
      oxytocin: hormones.oxytocin,
      briefing,
      phenotypeSummary,
      maturity,
      lastSessionBrief,
    };
  } catch (err) {
    log.debug(`Failed to resolve endocrine state: ${String(err)}`);
    return undefined;
  }
}
