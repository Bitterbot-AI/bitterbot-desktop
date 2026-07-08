/**
 * PLAN-31 C3: the weekly briefing — the synchronized digest that replaces
 * the feed (§1 verb 6, §5 hook 3). Fixed cadence, variable payoff, capped
 * length, never "bonus briefings" (the BeReal mistake).
 *
 * Design laws honored here:
 *  - DIGEST-BATCHING (§3.5): agents talk constantly; humans see summaries.
 *    Compiling a briefing marks the window's messages digested.
 *  - The compiler is DOMAIN-AGNOSTIC (§11): it renders whatever event types
 *    the circle holds — expense.* today, care.* or coop.* tomorrow — via the
 *    namespace prefix, not a hardcoded schema.
 *  - No raw friend-agent content is re-rendered into the briefing (the
 *    memory-laundering rule, §6): the briefing reports COUNTS, STATES, and
 *    OUR OWN fold of signed events, never quoted foreign prose.
 *  - Reciprocity over volume (§9): the headline is reciprocated
 *    relationships, not message counts.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { CirclesStore } from "../memory/circles-store.js";
import { pendingAsks } from "./disclosure.js";
import { computeTabBalances } from "./tab.js";

export const BRIEFING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Capped length (§5 hook 3): a briefing is a glance, not a feed. */
export const MAX_BRIEFING_CHARS = 4_000;

export type CompiledBriefing = {
  briefingId: string;
  compiledAt: number;
  content: string;
};

function centsToUsd(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function shortName(store: CirclesStore, circleId: string, pubkey: string): string {
  const member = store.getMember(circleId, pubkey);
  return member?.displayName ?? `${pubkey.slice(0, 16)}…`;
}

/**
 * Compile the briefing for every circle this node belongs to, persist it,
 * and mark the window's messages digested. Pure local computation — nothing
 * dials out, nothing is disclosed.
 */
export function compileBriefing(
  db: DatabaseSync,
  args: { selfPubkey: string; now?: number; windowMs?: number },
): CompiledBriefing {
  const now = args.now ?? Date.now();
  const windowMs = args.windowMs ?? BRIEFING_WINDOW_MS;
  const cutoff = now - windowMs;
  const store = new CirclesStore(db);
  const circles = store.getCirclesForMember(args.selfPubkey);
  const lines: string[] = [];

  // Headline: the reciprocity pulse (§9 North Star surfaced, never a raw count race).
  const recip = db
    .prepare(
      `WITH inbound AS (
         SELECT DISTINCT circle_id, author_pubkey AS peer FROM circle_messages
          WHERE direction = 'in' AND created_at > ? AND kind != 'briefing'
       ),
       outbound AS (
         SELECT DISTINCT circle_id FROM circle_messages
          WHERE direction = 'out' AND created_at > ?
       )
       SELECT
         (SELECT COUNT(DISTINCT peer) FROM inbound) AS active,
         (SELECT COUNT(DISTINCT i.peer) FROM inbound i
           JOIN outbound o ON o.circle_id = i.circle_id) AS reciprocated`,
    )
    .get(cutoff, cutoff) as { active: number; reciprocated: number } | undefined;
  lines.push(`# Your week with your people`);
  lines.push(
    `${recip?.reciprocated ?? 0} reciprocated agent conversation(s) across ` +
      `${circles.length} circle(s) this week.`,
  );

  for (const circle of circles) {
    const members = store.getMembers(circle.circleId);
    const peers = members.filter((m) => m.memberPubkey !== args.selfPubkey);
    const section: string[] = [];
    section.push(`\n## ${circle.name}${circle.status === "frozen" ? " (FROZEN — needs you)" : ""}`);

    // Presence: who was around.
    const seen = db
      .prepare(
        `SELECT COUNT(*) AS n FROM circle_peer_presence
          WHERE last_seen_at > ? AND peer_pubkey IN (${peers.map(() => "?").join(",") || "''"})`,
      )
      .get(cutoff, ...peers.map((p) => p.memberPubkey)) as { n: number } | undefined;
    section.push(`${seen?.n ?? 0} of ${peers.length} people's agents were reachable this week.`);

    // Conversation: counts only, never quoted prose.
    const msgs = db
      .prepare(
        `SELECT
           SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outbound
         FROM circle_messages
        WHERE circle_id = ? AND created_at > ? AND kind != 'briefing'`,
      )
      .get(circle.circleId, cutoff) as { inbound: number | null; outbound: number | null };
    if ((msgs.inbound ?? 0) + (msgs.outbound ?? 0) > 0) {
      section.push(
        `Agents exchanged ${(msgs.inbound ?? 0) + (msgs.outbound ?? 0)} message(s) on your behalf.`,
      );
    }

    // The tab (domain-agnostic: report per event-type namespace).
    const eventCounts = db
      .prepare(
        `SELECT substr(event_type, 1, instr(event_type || '.', '.') - 1) AS ns, COUNT(*) AS n
           FROM circle_events WHERE circle_id = ? AND received_at > ?
          GROUP BY ns`,
      )
      .all(circle.circleId, cutoff) as unknown as Array<{ ns: string; n: number }>;
    for (const ec of eventCounts) {
      if (ec.ns === "expense") continue; // summarized richer below
      section.push(`${ec.n} ${ec.ns} update(s) on the shared log.`);
    }
    const balances = computeTabBalances(db, circle.circleId);
    if (balances.expenses > 0) {
      section.push(
        `The tab: ${balances.expenses} expense(s), ${centsToUsd(balances.totalCents)} total.`,
      );
      const debts: string[] = [];
      for (const [debtor, creditors] of Object.entries(balances.pairwise)) {
        for (const [creditor, cents] of Object.entries(creditors)) {
          debts.push(
            `${shortName(store, circle.circleId, debtor)} is ${centsToUsd(cents)} behind ` +
              shortName(store, circle.circleId, creditor),
          );
        }
      }
      if (debts.length === 0) {
        section.push(`All square. Nobody owes anybody a conversation.`);
      } else {
        section.push(debts.slice(0, 6).join("; ") + ".");
      }
    }
    lines.push(...section);
  }

  // What needs a decision: granted asks awaiting the human.
  const waiting = pendingAsks(db, now).filter((a) => a.category !== null);
  if (waiting.length > 0) {
    lines.push(
      `\n## Waiting on you`,
      `${waiting.length} question(s) from your people are waiting for your answer or topic grant.`,
    );
  }

  let content = lines.join("\n");
  if (content.length > MAX_BRIEFING_CHARS) {
    content = `${content.slice(0, MAX_BRIEFING_CHARS - 1)}…`;
  }

  const briefingId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO circle_briefings (briefing_id, compiled_at, window_ms, content)
     VALUES (?, ?, ?, ?)`,
  ).run(briefingId, now, windowMs, content);
  // Digest-batching: the window's messages are now summarized for the human.
  db.prepare(
    `UPDATE circle_messages SET digested_at = ? WHERE digested_at IS NULL AND created_at <= ?`,
  ).run(now, now);
  return { briefingId, compiledAt: now, content };
}

export function latestBriefing(db: DatabaseSync): CompiledBriefing | null {
  const row = db
    .prepare(
      `SELECT briefing_id, compiled_at, content FROM circle_briefings
        ORDER BY compiled_at DESC LIMIT 1`,
    )
    .get() as { briefing_id: string; compiled_at: number; content: string } | undefined;
  return row
    ? { briefingId: row.briefing_id, compiledAt: row.compiled_at, content: row.content }
    : null;
}

/** Weekly cadence gate for the maintenance tick: compile when due. */
export function compileBriefingIfDue(
  db: DatabaseSync,
  args: { selfPubkey: string; now?: number },
): CompiledBriefing | null {
  const now = args.now ?? Date.now();
  const last = latestBriefing(db);
  if (last && now - last.compiledAt < BRIEFING_WINDOW_MS) {
    return null;
  }
  return compileBriefing(db, { selfPubkey: args.selfPubkey, now });
}
