/**
 * PLAN-31 C1/C2: circles gateway RPCs — the HUMAN surface of the connection
 * graph (the UI/CLI drives these; friends' nodes drive the A2A circle/*
 * verbs instead).
 *
 *  circles.status  — enabled?, our pubkey, connection count, reciprocity.
 *  circles.list    — circles we belong to, with members + peer liveness.
 *  circles.create  — create a circle (kind free string; "connection" = edge).
 *  circles.invite  — mint an invite code (the code returns ONCE).
 *  circles.join    — redeem a pasted invite code (the invitee-side consent:
 *                    the human saw who is asking before calling this).
 *  circles.send    — send a message/ask/answer into a circle as our agent.
 *  circles.messages— the conversation buffer for a circle (wrapped inbound).
 *
 * Everything requires the circles.enabled kill switch (PLAN-31 §8: dark by
 * default until the C2 security review) and answers UNAVAILABLE when off.
 */

import type { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listDisclosureGrants, setDisclosureGrant } from "../../circles/disclosure.js";
import { CirclesService } from "../../circles/service.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

async function getCirclesDb(): Promise<DatabaseSync | null> {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  const economics = (
    manager as unknown as {
      getMarketplaceEconomics?: () => { getDb?: () => DatabaseSync | undefined } | null;
    }
  ).getMarketplaceEconomics?.();
  return economics?.getDb?.() ?? null;
}

async function getService(): Promise<
  { ok: true; service: CirclesService } | { ok: false; error: string }
> {
  const config = loadConfig();
  if (config.circles?.enabled !== true) {
    return {
      ok: false,
      error: "circles are disabled (set circles.enabled=true; ships dark per PLAN-31 §8)",
    };
  }
  const db = await getCirclesDb();
  if (!db) {
    return { ok: false, error: "circles storage unavailable" };
  }
  return { ok: true, service: new CirclesService({ db, config }) };
}

export const circlesHandlers: GatewayRequestHandlers = {
  "circles.status": async ({ respond }) => {
    const config = loadConfig();
    if (config.circles?.enabled !== true) {
      respond(true, { enabled: false }, undefined);
      return;
    }
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    respond(
      true,
      {
        enabled: true,
        pubkey: svc.service.pubkey,
        connectionCount: svc.service.connectionCount(),
        reciprocity: svc.service.reciprocity(),
        a2aPublicUrl: config.circles?.a2aPublicUrl ?? null,
      },
      undefined,
    );
  },

  "circles.list": async ({ respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const presence = new Map(svc.service.peerPresence().map((p) => [p.peerPubkey, p] as const));
    const circles = svc.service.listCircles().map((c) => ({
      circleId: c.circleId,
      name: c.name,
      kind: c.kind,
      status: c.status,
      keyEpoch: c.keyEpoch,
      createdAt: c.createdAt,
      members: svc.service.store.getMembers(c.circleId).map((m) => ({
        memberPubkey: m.memberPubkey,
        displayName: m.displayName,
        role: m.role,
        isSelf: m.memberPubkey === svc.service.pubkey,
        lastSeenAt: presence.get(m.memberPubkey)?.lastSeenAt ?? null,
        lastStatus: presence.get(m.memberPubkey)?.lastStatus ?? null,
      })),
    }));
    respond(true, { circles }, undefined);
  },

  "circles.create": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name required"));
      return;
    }
    const kind = typeof params.kind === "string" && params.kind ? params.kind : "connection";
    const circleId = svc.service.createCircle({ name, kind });
    respond(true, { circleId }, undefined);
  },

  "circles.invite": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    try {
      const invite = svc.service.createInviteCode({
        circleId: typeof params.circleId === "string" ? params.circleId : undefined,
        name: typeof params.name === "string" ? params.name : undefined,
      });
      respond(true, invite, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.join": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const code = typeof params.code === "string" ? params.code.trim() : "";
    if (!code) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "code required"));
      return;
    }
    try {
      const joined = await svc.service.redeemInviteCode(code);
      respond(true, joined, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.send": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const text = typeof params.text === "string" ? params.text.trim() : "";
    const kind =
      params.kind === "ask" || params.kind === "answer" ? params.kind : ("message" as const);
    if (!circleId || !text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId, text required"));
      return;
    }
    try {
      const report = await svc.service.sendMessage({
        circleId,
        text,
        kind,
        threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      });
      respond(true, report, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.briefing": async ({ respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    respond(true, { briefing: svc.service.briefing() }, undefined);
  },

  "circles.ask": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const question = typeof params.question === "string" ? params.question.trim() : "";
    const category = typeof params.category === "string" ? params.category : "";
    if (!circleId || !question || !category) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, question, category required"),
      );
      return;
    }
    try {
      const report = await svc.service.askPeople({ circleId, question, category });
      respond(true, report, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.disclosure.set": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const category = typeof params.category === "string" ? params.category : "";
    if (!category || typeof params.allowed !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "category, allowed required"),
      );
      return;
    }
    try {
      setDisclosureGrant(svc.service.dbHandle, {
        category,
        circleId: typeof params.circleId === "string" ? params.circleId : undefined,
        allowed: params.allowed,
      });
      respond(true, { grants: listDisclosureGrants(svc.service.dbHandle) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.disclosure.list": async ({ respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    respond(true, { grants: listDisclosureGrants(svc.service.dbHandle) }, undefined);
  },

  "circles.tab.add": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    try {
      let input: import("../../circles/tab.js").TabEventInput;
      if (params.type === "expense.reversal" && typeof params.reverses === "string") {
        input = { type: "expense.reversal", reverses: params.reverses };
      } else if (params.type === "note.add" && typeof params.memo === "string") {
        input = { type: "note.add", memo: params.memo };
      } else if (
        typeof params.memo === "string" &&
        typeof params.amountCents === "number" &&
        Array.isArray(params.participants)
      ) {
        input = {
          type: "expense.add",
          memo: params.memo,
          amountCents: params.amountCents,
          participants: (params.participants as unknown[]).filter(
            (p): p is string => typeof p === "string",
          ),
        };
      } else {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "expense.add {memo, amountCents, participants}, expense.reversal {reverses}, or note.add {memo}",
          ),
        );
        return;
      }
      const result = await svc.service.appendTabEvent({ circleId, input });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.tab.balances": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    respond(true, svc.service.tabBalances(circleId), undefined);
  },

  "circles.sync": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    try {
      const events = await svc.service.syncEvents(circleId);
      respond(true, events, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.messages": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    const limit = typeof params.limit === "number" ? params.limit : 100;
    respond(true, { messages: svc.service.messages(circleId, limit) }, undefined);
  },
};
