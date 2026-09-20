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

const FACT_LINE_RE = /^- \[([^\]]+)\] /;
const FACT_META_SUFFIX_RE =
  / \((?:confirmed \d+x, last \d{4}-\d{2}-\d{2}|since \d{4}-\d{2}-\d{2})\)\s*$/;

/**
 * Token-efficiency W4: the prompt rendering of the ledger carries NO
 * confirmation counts or dates and lists facts sorted by key. The data is
 * untouched (memory_status / memory_search still expose counts and dates);
 * only the projection changes, so the block's bytes move only when a fact
 * is added, retired or reworded, never on every confirmation.
 *
 * W6: `CanonicalFactsStore.renderBlock` now emits `- [key] value` lines with
 * no suffix at all, so on the live path this is a sort-only pass; it stays
 * as the guard for any pre-W6 block (tests, older stores) that still carries
 * the `(confirmed Nx, last date)` / `(since date)` suffix.
 */
export function stripCanonicalFactMetadata(block: string): string {
  const lines = block.split("\n");
  const header: string[] = [];
  const facts: Array<{ key: string; line: string }> = [];
  for (const line of lines) {
    const match = FACT_LINE_RE.exec(line);
    if (!match) {
      if (facts.length === 0) {
        header.push(line);
      }
      continue;
    }
    facts.push({ key: match[1] ?? "", line: line.replace(FACT_META_SUFFIX_RE, "") });
  }
  facts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...header, ...facts.map((fact) => fact.line)].join("\n");
}

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
    return block ? stripCanonicalFactMetadata(block) : block;
  } catch (err) {
    log.debug(`canonical facts block unavailable: ${String(err)}`);
    return undefined;
  }
}
