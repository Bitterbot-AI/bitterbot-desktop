/**
 * PLAN-34 Phase 2b — resolve the Research Findings block for system-prompt
 * injection: the "while you were away, I looked into X" line.
 *
 * Same discipline as resolveCanonicalFactsBlock (the PLAN-33 lesson this
 * plan codifies): an independent prompt-assembly call with no hormonal,
 * embedding, or handover dependencies — the finding renders even when
 * resolveEndocrineState returns undefined. Full prompt mode only: subagent
 * and cron fan-outs must not consume (or leak) the owner's findings.
 */

import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("research-findings-block");

export async function resolveResearchFindingsBlock(params: {
  config?: BitterbotConfig;
  agentId: string;
  promptMode?: "full" | "minimal" | "none";
  /**
   * PLAN-34 Phase 2 adversarial fix: consume (surface exactly once) ONLY on
   * a genuine first-party live user turn. False for heartbeats, hooks,
   * subagents, cron, and any non-first-party session — those must never
   * drain the owner's brief into an ephemeral or third-party transcript.
   * The caller computes this from the session key + heartbeat flag.
   */
  liveUserTurn?: boolean;
  /**
   * PLAN-40 Lane 3: anticipatory briefs synthesize across the OWNER's
   * sessions, and `first_party` is a token-denylist (a stranger's DM
   * classifies first_party — adversarial F5-r2). Briefs drain ONLY when the
   * caller resolves the session to the owner: CLI/local sessions, or a
   * channel DM whose peer is in ownerNumbers. Findings keep the looser
   * first-party gate for backward compatibility.
   */
  ownerTurn?: boolean;
}): Promise<string | undefined> {
  if (params.promptMode && params.promptMode !== "full") {
    return undefined;
  }
  if (params.liveUserTurn === false) {
    return undefined;
  }
  const autoResearch = (
    params.config?.memory?.curiosity as { autoResearch?: { enabled?: boolean } } | undefined
  )?.autoResearch;
  if (autoResearch?.enabled === false) {
    return undefined;
  }
  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const manager = await MemoryIndexManager.get({
      cfg: params.config ?? {},
      agentId: params.agentId,
      purpose: "status",
    });
    if (!manager) {
      return undefined;
    }
    const findings = manager.consumeResearchFindings(3);
    const brief =
      params.ownerTurn === true &&
      typeof (manager as { consumeDreamBrief?: () => { question: string; answer: string } | null })
        .consumeDreamBrief === "function"
        ? (
            manager as unknown as {
              consumeDreamBrief(): { question: string; answer: string } | null;
            }
          ).consumeDreamBrief()
        : null;
    if (findings.length === 0 && !brief) {
      return undefined;
    }
    const lines = findings.map(
      (f) => `- ${f.finding}${f.sourceUrl ? ` (source: ${f.sourceUrl})` : ""}`,
    );
    const briefLines = brief
      ? [
          "",
          "## Anticipated (machine hunch — offer, don't assert)",
          `You suspected they may ask: ${brief.question}`,
          `Sketch: ${brief.answer}`,
          "If relevant, offer this naturally; if not, ignore it silently.",
        ]
      : [];
    const findingLines =
      findings.length > 0
        ? [
            "## Research Findings",
            "While idle, background research looked into open curiosity gaps.",
            "Mention these briefly to the user early in your reply (one sentence,",
            'e.g. "while you were away, I looked into X") — then move on.',
            ...lines,
          ]
        : [];
    return [...findingLines, ...briefLines].join("\n");
  } catch (err) {
    log.debug(`research findings block unavailable: ${String(err)}`);
    return undefined;
  }
}
