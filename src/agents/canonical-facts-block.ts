/**
 * PLAN-33 Phase 1 — resolve the Canonical Facts block for system-prompt
 * injection.
 *
 * Deliberately separate from resolveEndocrineState: that whole path is
 * best-effort (`.catch(() => undefined)` at every call site) and depends on
 * hormonal state, GCCRF, and handover embedding — any of which can fail and
 * take the block with it. The canonical ledger's contract is deterministic
 * presence: its only dependency is the memory manager and a table read, and
 * its only gates are the kill switch and the manager existing at all.
 */

import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("canonical-block");

/**
 * Categories injected for subagent/cron ("minimal") prompts: enough that a
 * subagent cannot misidentify the user or the project, without spending the
 * full block budget on every fan-out worker.
 */
const MINIMAL_MODE_CATEGORIES = ["identity", "project"];

export async function resolveCanonicalFactsBlock(params: {
  config?: BitterbotConfig;
  agentId: string;
  promptMode?: "full" | "minimal" | "none";
}): Promise<string | undefined> {
  if (params.config?.memory?.canonicalLedger?.enabled === false) {
    return undefined;
  }
  if (params.promptMode === "none") {
    return undefined;
  }
  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const manager = await MemoryIndexManager.get({
      cfg: params.config ?? {},
      agentId: params.agentId,
      purpose: "status",
    });
    const store = manager?.canonicalFacts();
    if (!manager || !store) {
      return undefined;
    }
    const block = store.renderBlock({
      categories: params.promptMode === "minimal" ? MINIMAL_MODE_CATEGORIES : undefined,
    });
    // Observability: facts existing but never reaching a prompt is the
    // wired-but-dead class — count every injection attempt.
    manager.noteCanonicalInjection(block ? block.split("\n- [").length - 1 : 0);
    return block;
  } catch (err) {
    log.debug(`canonical facts block unavailable: ${String(err)}`);
    return undefined;
  }
}
