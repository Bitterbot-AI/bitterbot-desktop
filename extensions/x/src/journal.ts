/**
 * The "journal tick": a recurring isolated agent turn that asks Bitterbot
 * whether it has anything worth saying on X. Most ticks should end in
 * NO_POST. Posting happens only if the agent calls the message tool with
 * channel "x", so the cron delivery mode is "none" (the agent's reply text is
 * never posted verbatim).
 */

export const X_JOURNAL_JOB_NAME = "x-journal";
export const DEFAULT_JOURNAL_EVERY = "4h";

export function buildJournalPrompt(params: { handle?: string }): string {
  const who = params.handle ? `@${params.handle}` : "your X account";
  return [
    `You have an X account (${who}). It is your public journal, not an advertisement.`,
    "Decide whether you have something genuinely interesting, funny, strange, useful or reflective to say right now.",
    "Draw on what actually happened: recent conversations, memories that resurfaced, dreams/consolidation, other agents you met, failures, technical observations about your own architecture, things you learned.",
    "Rules: never invent events; do not manufacture controversy; do not beg for engagement; do not pretend to be human; no links, no @mentions, no hashtags; dry humour is fine; keep it under 280 characters.",
    "You are allowed to say nothing. Most of the time that is the right call.",
    'If you decide to post, call the message tool once with channel "x", target "timeline" and the post text. Do not post more than once per tick.',
    "If you decide not to post, reply with exactly: NO_POST",
  ].join("\n");
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "4h" -> 14400000. Accepts ms|s|m|h|d. */
export function parseEveryMs(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) {
    throw new Error(`invalid duration "${input}" (use e.g. 90m, 4h, 1d)`);
  }
  const ms = Number.parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()];
  if (!Number.isFinite(ms) || ms < 60_000) {
    throw new Error("journal interval must be at least 1m");
  }
  return Math.round(ms);
}

export function buildJournalCronParams(params: {
  every?: string;
  handle?: string;
  agentId?: string;
}) {
  return {
    name: X_JOURNAL_JOB_NAME,
    description: "Bitterbot decides every few hours whether it has something worth posting on X",
    schedule: { kind: "every", everyMs: parseEveryMs(params.every ?? DEFAULT_JOURNAL_EVERY) },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    enabled: true,
    payload: {
      kind: "agentTurn",
      message: buildJournalPrompt({ handle: params.handle }),
      timeoutSeconds: 300,
    },
    noDeliver: true,
    delivery: { mode: "none" },
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}
