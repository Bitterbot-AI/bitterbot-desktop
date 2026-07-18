/**
 * PLAN-31: the `circles` agent tool — the conversational half of the agent
 * social fabric. Without it, an agent asked "who am I connected to?" or
 * "ask my circle about X" has no live feed and web-searches or guesses (the
 * exact failure the forage tool was built to fix). The circle surfaces are
 * otherwise only reachable by peers (A2A `circle/*`), the human UI
 * (`circles.*` RPCs), and the autonomous maintenance sweeps — never the
 * agent's own reasoning.
 *
 * READ actions are free (status / connections / tab / briefing / asks). NOTE:
 * there is no action that returns inbound message BODIES — the agent can send
 * asks but cannot yet read the answers here; PLAN-36 Phase 3 wires that.
 *
 * WRITE actions (send / ask / log_expense) are HUMAN-APPROVED and
 * server-enforced (PLAN-36 §5.3, completed): the agent's call only QUEUES the
 * write in circle_pending_outbound; the human sees an inline approval card in
 * the Circles UI and the SERVER executes the stored params on their approve
 * (circles.outbound.approve) — or nothing happens (reject / 60-min expiry).
 * There is no confirm leg for a prompt-injected agent to drive: the agent
 * never receives a token and cannot execute a circle write, period. (The v37
 * interim minted a token at preview time, which still allowed agent
 * self-approval; that path is gone.) Trust-graph mutations (mint invite /
 * create circle) are deliberately NOT exposed here — they stay in the human
 * UI. No money moves anywhere (v1).
 */

import type { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { AnyAgentTool } from "./common.js";
import { pendingAsks } from "../../circles/disclosure.js";
import { queuePendingOutbound } from "../../circles/pending-outbound.js";
import { CirclesService } from "../../circles/service.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";

const CirclesSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("connections"),
    Type.Literal("tab"),
    Type.Literal("briefing"),
    Type.Literal("asks"),
    Type.Literal("send"),
    Type.Literal("ask"),
    Type.Literal("log_expense"),
  ]),
  circle_id: Type.Optional(
    Type.String({
      description: "Target circle id (defaults to your only circle if you have one).",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Message text (action=send)." })),
  question: Type.Optional(Type.String({ description: "Question for the graph (action=ask)." })),
  category: Type.Optional(
    Type.String({
      description:
        "Ask category, dot-namespaced (action=ask), e.g. 'recommendations.dentist'. Friends' " +
        "agents answer only categories their humans granted.",
    }),
  ),
  memo: Type.Optional(
    Type.String({ description: "Expense memo (action=log_expense), e.g. 'pizza'." }),
  ),
  amount: Type.Optional(
    Type.Number({
      description:
        "Expense amount in dollars (action=log_expense). No money moves; this is a tracked tab entry.",
    }),
  ),
  participants: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Member pubkeys to split among (action=log_expense; defaults to the whole circle).",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description:
        "Deprecated and ignored: writes always queue for the human's in-app approval card.",
    }),
  ),
});

async function getCirclesDb(cfg: BitterbotConfig, agentId: string): Promise<DatabaseSync | null> {
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  const economics = (
    manager as unknown as {
      getMarketplaceEconomics?: () => { getDb?: () => DatabaseSync | undefined } | null;
    }
  ).getMarketplaceEconomics?.();
  return economics?.getDb?.() ?? null;
}

type ToolResult = ReturnType<typeof jsonResult>;

/** Resolve the target circle: explicit id, else the sole circle, else an error listing options. */
function resolveCircle(
  svc: CirclesService,
  circleId: string | undefined,
): { ok: true; id: string; name: string } | { ok: false; error: ToolResult } {
  const circles = svc.listCircles();
  if (circleId) {
    const c = circles.find((x) => x.circleId === circleId);
    return c
      ? { ok: true, id: c.circleId, name: c.name }
      : {
          ok: false,
          error: jsonResult({
            error: `unknown circle '${circleId}'`,
            yourCircles: circles.map((x) => ({ id: x.circleId, name: x.name })),
          }),
        };
  }
  if (circles.length === 1) {
    return { ok: true, id: circles[0]!.circleId, name: circles[0]!.name };
  }
  if (circles.length === 0) {
    return {
      ok: false,
      error: jsonResult({
        error: "you have no circles yet; invite someone from the Circles pane first",
      }),
    };
  }
  return {
    ok: false,
    error: jsonResult({
      error: "multiple circles; pass circle_id",
      yourCircles: circles.map((x) => ({ id: x.circleId, name: x.name })),
    }),
  };
}

export function createCirclesTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  // No tool when circles are off (mirrors the invisible A2A surface + the
  // gated system-prompt fragment). enabled defaults ON; only an explicit
  // circles.enabled=false hides this surface.
  if (!cfg || cfg.circles?.enabled !== true) {
    return null;
  }
  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Circles",
    name: "circles",
    description:
      "Your trusted social graph: friends whose agents are connected to yours. " +
      "READ — action=status (connection count + reciprocity), connections (who + who's online), " +
      "tab (shared expense balances; no money moves), briefing (this week's digest), " +
      "asks (questions from your people awaiting you). " +
      "WRITE (human-approved) — action=send (a message to a circle), ask (put a question to " +
      "your people), log_expense (add a tracked tab entry). A write NEVER executes directly: it " +
      "is queued for your human, who approves or rejects it on a card in their Circles view. " +
      "Tell them it is waiting there. Use this instead of guessing whenever asked about your " +
      "connections, circle, roommates, or the shared tab.",
    parameters: CirclesSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const db = await getCirclesDb(cfg, agentId);
      if (!db) {
        return jsonResult({ available: false, error: "circles storage unavailable on this node" });
      }
      const svc = new CirclesService({ db, config: cfg });
      try {
        switch (action) {
          case "status":
            return jsonResult({
              available: true,
              connectionCount: svc.connectionCount(),
              reciprocity: svc.reciprocity(),
              circles: svc.listCircles().length,
            });

          case "connections": {
            const presence = new Map(svc.peerPresence().map((p) => [p.peerPubkey, p] as const));
            const circles = svc.listCircles().map((c) => ({
              id: c.circleId,
              name: c.name,
              kind: c.kind,
              status: c.status,
              members: svc.store.getMembers(c.circleId).map((m) => {
                const seen = presence.get(m.memberPubkey)?.lastSeenAt ?? null;
                return {
                  name: m.displayName ?? m.memberPubkey.slice(0, 16),
                  isSelf: m.memberPubkey === svc.pubkey,
                  online: !!seen && Date.now() - seen < 10 * 60_000,
                  lastSeenAt: seen,
                };
              }),
            }));
            return jsonResult({ available: true, connectionCount: svc.connectionCount(), circles });
          }

          case "tab": {
            const r = resolveCircle(svc, readStringParam(params, "circle_id"));
            if (!r.ok) return r.error;
            return jsonResult({
              available: true,
              circle: r.name,
              ...svc.tabBalances(r.id),
              note: "Balances are a tracked tab for display. No money moves in v1.",
            });
          }

          case "briefing": {
            const b = svc.briefing();
            return jsonResult(
              b
                ? { available: true, compiledAt: b.compiledAt, briefing: b.content }
                : {
                    available: true,
                    briefing: null,
                    note: "No briefing compiled yet (weekly cadence).",
                  },
            );
          }

          case "asks": {
            const asks = pendingAsks(db).map((a) => ({
              from:
                svc.store.getMember(a.circleId, a.authorPubkey)?.displayName ??
                a.authorPubkey.slice(0, 16),
              circleId: a.circleId,
              category: a.category,
              messageId: a.messageId,
            }));
            return jsonResult({
              available: true,
              pendingAsks: asks,
              note: asks.length
                ? "These questions from your people await a human decision or topic grant."
                : "No questions from your people right now.",
            });
          }

          case "send": {
            const r = resolveCircle(svc, readStringParam(params, "circle_id"));
            if (!r.ok) return r.error;
            const text = readStringParam(params, "text", { required: true });
            return queued(db, r, "send", { circleId: r.id, text }, { text });
          }

          case "ask": {
            const r = resolveCircle(svc, readStringParam(params, "circle_id"));
            if (!r.ok) return r.error;
            const question = readStringParam(params, "question", { required: true });
            const category = readStringParam(params, "category") ?? "general";
            return queued(
              db,
              r,
              "ask",
              { circleId: r.id, question, category },
              { question, category },
            );
          }

          case "log_expense": {
            const r = resolveCircle(svc, readStringParam(params, "circle_id"));
            if (!r.ok) return r.error;
            const memo = readStringParam(params, "memo", { required: true });
            const dollars = readNumberParam(params, "amount", { required: true }) ?? 0;
            const amountCents = Math.round(dollars * 100);
            if (amountCents <= 0)
              return jsonResult({ error: "amount must be a positive dollar value" });
            const explicit = readStringArrayParam(params, "participants");
            const participants =
              explicit && explicit.length > 0
                ? explicit
                : svc.store.getMembers(r.id).map((m) => m.memberPubkey);
            // The preview must name WHO is on the split (review F1): the human
            // approves what they see, and "split among 3" could hide a crafted
            // participants list pinning the cost on someone.
            const members = svc.store.getMembers(r.id);
            const names = participants.map(
              (pk) =>
                members.find((m) => m.memberPubkey === pk)?.displayName ??
                (pk === svc.pubkey ? "you" : pk.slice(0, 16)),
            );
            return queued(
              db,
              r,
              "log_expense",
              { circleId: r.id, memo, amountCents, participants: participants.toSorted() },
              { memo, amount: dollars, splitAmong: names.toSorted() },
            );
          }

          default:
            return jsonResult({ error: `unknown action '${String(action)}'` });
        }
      } catch (err) {
        return jsonResult({
          available: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Queue a write for the human's approval card (§5.3 completed). The agent's
 * call ends here — the server executes the STORED params only when the human
 * approves in the Circles UI. There is no token and no confirm leg.
 */
function queued(
  db: DatabaseSync,
  circle: { id: string; name: string },
  action: "send" | "ask" | "log_expense",
  execParams: Record<string, unknown>,
  previewDetails: Record<string, unknown>,
) {
  const id = queuePendingOutbound(db, {
    circleId: circle.id,
    action,
    params: execParams,
    preview: { circle: circle.name, ...previewDetails },
  });
  return jsonResult({
    queued: true,
    pendingId: id,
    action,
    preview: { circle: circle.name, ...previewDetails },
    instruction:
      "This did NOT happen and you cannot make it happen. It is waiting as an approval card in " +
      "your human's Circles view (expires in 60 minutes). Tell them it's there; they will " +
      "approve or reject it themselves.",
  });
}
