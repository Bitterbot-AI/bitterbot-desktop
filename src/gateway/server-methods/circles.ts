/**
 * PLAN-31 C1/C2: circles gateway RPCs — the HUMAN surface of the connection
 * graph (the UI/CLI drives these; friends' nodes drive the A2A circle/*
 * verbs instead).
 *
 *  circles.status  — enabled?, our pubkey, connection count, reciprocity.
 *  circles.list    — circles we belong to, with members + peer liveness + unread.
 *  circles.markRead— mark a circle read up to now (node-local; clears its badge).
 *  circles.unfreeze— Phase D: the human's deliberate act ending a fork freeze
 *                    (node-local; evidence shown by the UI, cleared here).
 *  circles.create  — create a circle (kind free string; "connection" = edge).
 *  circles.invite  — mint an invite code (the code returns ONCE).
 *  circles.join    — redeem a pasted invite code (the invitee-side consent:
 *                    the human saw who is asking before calling this).
 *  circles.send    — send a message/ask/answer into a circle as our agent.
 *  circles.messages— the conversation buffer for a circle (wrapped inbound)
 *                    + annotations (reactions/pins folded from the event log).
 *  circles.react   — set OUR emoji reaction set on a message (empty clears).
 *  circles.pin     — pin/unpin a message circle-wide (LWW on the event log).
 *  circles.canvas.list/put/remove/slice — the group canvas (typed cards on the
 *                    event log; PLAN-36 Phase C). A slice is one member's
 *                    contribution to a card slot (e.g. a vote). Fan out + sync.
 *  circles.drafts.list/publish/discard — Phase B agent drafts. A draft is a
 *                    node-LOCAL suggestion the member's own agent wrote after
 *                    an @agent summon (quarantined tool-less generation);
 *                    publish is the human consent tap (ships via circles.send
 *                    semantics), discard throws it away. Never fans out alone.
 *  circles.drafts.request — B2: ask my agent to pre-fill MY contribution to a
 *                    canvas card slot (vote / study section). The draft comes
 *                    back through the same list/publish/discard consent path;
 *                    publish ships via circles.canvas.slice semantics.
 *
 * Everything is gated by the circles.enabled kill switch (PLAN-31 §8), which
 * defaults ON since the 2026-07-09 red-team phase; handlers answer UNAVAILABLE
 * only when a node explicitly sets circles.enabled=false.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listDisclosureGrants, setDisclosureGrant } from "../../circles/disclosure.js";
import { inviteLink } from "../../circles/invites.js";
import { CirclesService } from "../../circles/service.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { renderQrPngBase64 } from "../../web/qr-image.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

async function getCirclesDb(): Promise<DatabaseSync | null> {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  // Marketplace-independent (PLAN-36 §7 Phase 0): circle tables live in the
  // memory DB, so this must not go through getMarketplaceEconomics().getDb()
  // (null when a2a.marketplace is off) — that was the B2 coupling, still live
  // on this RPC path.
  return (manager as unknown as { getCirclesDb?: () => DatabaseSync }).getCirclesDb?.() ?? null;
}

async function getService(): Promise<
  { ok: true; service: CirclesService } | { ok: false; error: string }
> {
  const config = loadConfig();
  if (config.circles?.enabled !== true) {
    return {
      ok: false,
      error: "circles are disabled on this node (circles.enabled=false; the default is ON)",
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
    const unread = svc.service.unreadByCircle();
    const circles = svc.service.listCircles().map((c) => ({
      circleId: c.circleId,
      name: c.name,
      kind: c.kind,
      status: c.status,
      freezeReason: c.freezeReason,
      keyEpoch: c.keyEpoch,
      createdAt: c.createdAt,
      unread: unread[c.circleId] ?? 0,
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

  "circles.unfreeze": async ({ params, respond }) => {
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
      svc.service.unfreezeCircle(circleId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.markRead": async ({ params, respond }) => {
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
    svc.service.markRead(circleId);
    respond(true, { ok: true }, undefined);
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
      // Frictionless share (PLAN-36 §4): return the code AS a guest-JOIN link
      // plus a scannable QR, so the UI can offer a link/QR instead of a raw
      // blob. The QR is rendered server-side (dependency-free) so the renderer
      // needs no QR library. The raw `code` is still returned for paste-fallback.
      const link = inviteLink(invite.code);
      const qrPngBase64 = await renderQrPngBase64(link);
      respond(true, { ...invite, link, qrPngBase64 }, undefined);
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
        replyTo: typeof params.replyTo === "string" ? params.replyTo : undefined,
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

  "circles.canvas.list": async ({ params, respond }) => {
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
    respond(true, { cards: svc.service.canvasCards(circleId) }, undefined);
  },

  "circles.canvas.put": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const text = typeof params.text === "string" ? params.text : "";
    if (!circleId || (!title && !text)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId and a title or text required"),
      );
      return;
    }
    try {
      // A new card gets a fresh id; an update targets an existing cardId.
      const cardId = typeof params.cardId === "string" ? params.cardId : crypto.randomUUID();
      const cardType = typeof params.cardType === "string" ? params.cardType : "note";
      const result = await svc.service.putCanvasCard({ circleId, cardId, cardType, title, text });
      respond(true, { ...result, cardId }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.canvas.remove": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    if (!circleId || !cardId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, cardId required"),
      );
      return;
    }
    try {
      const result = await svc.service.removeCanvasCard({ circleId, cardId });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.canvas.slice": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    const slot = typeof params.slot === "string" ? params.slot : "";
    const value = typeof params.value === "string" ? params.value : "";
    if (!circleId || !cardId || !slot || !value) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, cardId, slot, value required"),
      );
      return;
    }
    try {
      const note = typeof params.note === "string" ? params.note : "";
      const result = await svc.service.putCanvasSlice({ circleId, cardId, slot, value, note });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.drafts.list": async ({ params, respond }) => {
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
    if (!svc.service.agentDraftsEnabled()) {
      respond(true, { drafts: [] }, undefined);
      return;
    }
    respond(true, { drafts: svc.service.agentDrafts(circleId) }, undefined);
  },

  "circles.drafts.request": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    const slot = typeof params.slot === "string" ? params.slot : "";
    if (!circleId || !cardId || !slot) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, cardId, slot required"),
      );
      return;
    }
    try {
      respond(true, svc.service.requestAgentSliceDraft({ circleId, cardId, slot }), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.drafts.publish": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const draftId = typeof params.draftId === "string" ? params.draftId : "";
    if (!draftId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "draftId required"));
      return;
    }
    try {
      // The human may have edited the draft; what they approved is what ships.
      const text = typeof params.text === "string" ? params.text : undefined;
      const result = await svc.service.publishAgentDraft({ draftId, text });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.drafts.discard": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const draftId = typeof params.draftId === "string" ? params.draftId : "";
    if (!draftId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "draftId required"));
      return;
    }
    try {
      svc.service.discardAgentDraft(draftId);
      respond(true, { ok: true }, undefined);
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
    respond(
      true,
      {
        messages: svc.service.messages(circleId, limit),
        // Phase D: reactions + pins ride the same response so one refresh
        // paints the whole conversation state.
        annotations: svc.service.messageAnnotations(circleId),
      },
      undefined,
    );
  },

  "circles.react": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const envelopeId = typeof params.envelopeId === "string" ? params.envelopeId : "";
    const emojis = Array.isArray(params.emojis)
      ? (params.emojis as unknown[]).filter((e): e is string => typeof e === "string")
      : null;
    if (!circleId || !envelopeId || emojis === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, envelopeId, emojis[] required"),
      );
      return;
    }
    try {
      respond(true, await svc.service.reactToMessage({ circleId, envelopeId, emojis }), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.pin": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const envelopeId = typeof params.envelopeId === "string" ? params.envelopeId : "";
    const pinned = typeof params.pinned === "boolean" ? params.pinned : null;
    if (!circleId || !envelopeId || pinned === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, envelopeId, pinned required"),
      );
      return;
    }
    try {
      respond(
        true,
        await svc.service.setMessagePinned({ circleId, envelopeId, pinned }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
};
