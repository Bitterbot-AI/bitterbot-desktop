/**
 * PLAN-31 C1/C2: circles gateway RPCs — the HUMAN surface of the connection
 * graph (the UI/CLI drives these; friends' nodes drive the A2A circle/*
 * verbs instead).
 *
 *  circles.status  — enabled?, our pubkey, connection count, reciprocity, our
 *                    own display name (§5.6).
 *  circles.self.setName — §5.6: set the name friends see you by (node-local
 *                    setting, pushed via presence so existing rosters refresh).
 *  circles.list    — circles we belong to (incl. frozen + archived for the UI),
 *                    with members + peer liveness + unread.
 *  circles.archive/unarchive — hide/restore a circle (node-local, reversible).
 *  circles.delete  — permanently remove a circle from THIS node (all local
 *                    data; friends keep their own copy — P2P, no central authority).
 *  circles.markRead— mark a circle read up to now (node-local; clears its badge).
 *  circles.unfreeze— Phase D: the human's deliberate act ending a fork freeze
 *                    (node-local; evidence shown by the UI, cleared here).
 *  circles.member.remove — §5.5: ANY member prunes another from their own
 *                    node's roster (node-local self-protection; not
 *                    creator-gated). The removed member's writes are
 *                    default-denied at the A2A boundary from here on, and a
 *                    signed removal notice fans to the remaining members so
 *                    their humans can prune their own rosters too.
 *  circles.petname.set/clear — §5.6: the viewer's PRIVATE per-person label for
 *                    a member (node-local, keyed by pubkey; overrides the
 *                    self-asserted displayName for this node's eyes only,
 *                    never synced). circles.list carries petname + the
 *                    unverified / nameCollision affordances.
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
 *  circles.study.record/state — Phase 4b: the study lens's member-own mastery
 *                    loop. `record` logs one quiz result (the human's own tap
 *                    on a study draft question; Leitner box + spaced due date
 *                    update); `state` reads it back for due badges. Node-local
 *                    data that never fans out and never enters recall (§5.2).
 *  circles.drafts.request — B2: ask my agent to pre-fill MY contribution to a
 *                    canvas card slot (vote / study section). The draft comes
 *                    back through the same list/publish/discard consent path;
 *                    publish ships via circles.canvas.slice semantics.
 *  circles.outbound.list/approve/reject — §5.3 completed: agent tool writes
 *                    (send/ask/log_expense) only QUEUE; the human's approval
 *                    card here is the ONLY path that executes (server runs the
 *                    stored params) or rejects them. 60-min expiry.
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
import { inviteLink, parseInviteCode, revokeInvite } from "../../circles/invites.js";
import { computeNameFlags } from "../../circles/petnames.js";
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
        // §5.6: the name friends see you by (editable in-app).
        displayName: svc.service.myDisplayName(),
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
    const selfPubkey = svc.service.pubkey;
    // §5.6 petname layer: the viewer's private labels + per-member name-safety
    // flags. Members are read ONCE per circle; the flags (unverified /
    // impersonation collision) are computed by the pure, tested helper — the
    // collision keys on the SPOOFABLE displayName so petnaming a friend doesn't
    // blind the cue to an impostor copying their name (review F1/F2).
    const petnames = svc.service.petnames();
    // UI list includes frozen + archived (so the rail can show them, the
    // unfreeze banner is reachable, and archived circles can be restored).
    const allCircles = svc.service.listCirclesForUi();
    const membersByCircle = new Map(
      allCircles.map((c) => [c.circleId, svc.service.store.getMembers(c.circleId)] as const),
    );
    const flags = computeNameFlags(
      [...membersByCircle.values()].flat().map((m) => ({
        memberPubkey: m.memberPubkey,
        displayName: m.displayName,
        isSelf: m.memberPubkey === selfPubkey,
      })),
      petnames,
    );
    const circles = allCircles.map((c) => ({
      circleId: c.circleId,
      name: c.name,
      kind: c.kind,
      status: c.status,
      freezeReason: c.freezeReason,
      keyEpoch: c.keyEpoch,
      createdAt: c.createdAt,
      unread: unread[c.circleId] ?? 0,
      members: (membersByCircle.get(c.circleId) ?? []).map((m) => {
        const f = flags.get(m.memberPubkey);
        return {
          memberPubkey: m.memberPubkey,
          displayName: m.displayName,
          petname: petnames[m.memberPubkey] ?? null,
          role: m.role,
          isSelf: m.memberPubkey === selfPubkey,
          unverified: f?.unverified ?? false,
          nameCollision: f?.nameCollision ?? false,
          lastSeenAt: presence.get(m.memberPubkey)?.lastSeenAt ?? null,
          lastStatus: presence.get(m.memberPubkey)?.lastStatus ?? null,
          // Mockup pin 3: the roster answers "who and what can hear this".
          // Self is computed live; peers self-report on the presence beat
          // (allowlisted on receipt; null until their node ships the field).
          agentPosture:
            m.memberPubkey === selfPubkey
              ? svc.service.selfAgentPosture()
              : (presence.get(m.memberPubkey)?.agentPosture ?? null),
        };
      }),
    }));
    respond(true, { circles }, undefined);
  },

  "circles.rename": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const name = typeof params.name === "string" ? params.name : "";
    if (!circleId || !name.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId, name required"));
      return;
    }
    try {
      svc.service.renameCircle({ circleId, name });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.archive": async ({ params, respond }) => {
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
      svc.service.archiveCircle(circleId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.unarchive": async ({ params, respond }) => {
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
      svc.service.unarchiveCircle(circleId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.delete": async ({ params, respond }) => {
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
      svc.service.deleteCircle(circleId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
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

  "circles.self.setName": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const name = typeof params.name === "string" ? params.name : "";
    try {
      await svc.service.setDisplayName(name);
      respond(true, { ok: true, displayName: svc.service.myDisplayName() }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.petname.set": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const memberPubkey = typeof params.memberPubkey === "string" ? params.memberPubkey : "";
    const petname = typeof params.petname === "string" ? params.petname : "";
    if (!memberPubkey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "memberPubkey required"));
      return;
    }
    try {
      svc.service.setPetname(memberPubkey, petname);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.petname.clear": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const memberPubkey = typeof params.memberPubkey === "string" ? params.memberPubkey : "";
    if (!memberPubkey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "memberPubkey required"));
      return;
    }
    svc.service.clearPetname(memberPubkey);
    respond(true, { ok: true }, undefined);
  },

  "circles.member.remove": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const memberPubkey = typeof params.memberPubkey === "string" ? params.memberPubkey : "";
    if (!circleId || !memberPubkey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, memberPubkey required"),
      );
      return;
    }
    try {
      await svc.service.removeMember({ circleId, memberPubkey });
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
      const sendToPubkey = typeof params.sendToPubkey === "string" ? params.sendToPubkey : "";
      if (sendToPubkey) {
        // "Add someone I know": mint a TARGET-BOUND invite (only that pubkey
        // can redeem — interception and co-member races are useless) and
        // deliver it through the 1:1 circle we share. The receiver still
        // consents by tapping Join on their side.
        if (!/^ed25519:[0-9a-f]{64}$/.test(sendToPubkey)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "bad sendToPubkey"));
          return;
        }
        if (sendToPubkey === svc.service.pubkey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "cannot invite yourself"),
          );
          return;
        }
        const invite = svc.service.createInviteCode({
          circleId: typeof params.circleId === "string" ? params.circleId : undefined,
          name: typeof params.name === "string" ? params.name : undefined,
          targetPubkey: sendToPubkey,
        });
        try {
          const circleName = svc.service.store.getCircle(invite.circleId)?.name ?? "a circle";
          const sent = await svc.service.sendInviteToConnection({
            code: invite.code,
            targetPubkey: sendToPubkey,
            circleName,
          });
          respond(
            true,
            { ...invite, sentVia: sent.viaCircleId, delivered: sent.delivered },
            undefined,
          );
        } catch (err) {
          // Delivery failed: don't leave a live-open invite row behind
          // (review #5) — the code was never shown to anyone.
          revokeInvite(svc.service.dbHandle, invite.inviteId);
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        }
        return;
      }
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

  "circles.inviteInfo": async ({ params, respond }) => {
    // Parse + signature-verify an invite code WITHOUT joining, so the UI can
    // show WHO is actually asking (the code's verified signer, which may
    // differ from whoever delivered the code) before the human consents.
    const code = typeof params.code === "string" ? params.code.trim() : "";
    if (!code) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "code required"));
      return;
    }
    if (code.length > 8192) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "code too large"));
      return;
    }
    const parsed = parseInviteCode(code);
    if (!parsed.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error));
      return;
    }
    // Cross-check the VERIFIED signer key against people this node already
    // knows (review #3): a stranger writing inviterName "Maya" must not read
    // as your Maya. knownAs resolves petname-first from YOUR labels.
    let knownAs: string | null = null;
    const svc = await getService();
    if (svc.ok) {
      const pk = parsed.invite.inviterPubkey;
      const petname = svc.service.petnames()[pk];
      if (petname) {
        knownAs = petname;
      } else {
        for (const c of svc.service.listCircles()) {
          const m = svc.service.store.getMembers(c.circleId).find((x) => x.memberPubkey === pk);
          if (m?.displayName) {
            knownAs = m.displayName;
            break;
          }
        }
      }
    }
    respond(
      true,
      {
        circleName: parsed.invite.circleName,
        inviterName: parsed.invite.inviterName,
        inviterPubkey: parsed.invite.inviterPubkey,
        knownAs,
      },
      undefined,
    );
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
    const state = svc.service.canvasState(circleId);
    respond(true, { cards: state.cards, removed: state.removed }, undefined);
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

  // §3.2.9: clear = tombstone + re-put with the same title under a fresh card
  // id (fresh session by construction). keepText chooses whether the body
  // survives the reset.
  "circles.canvas.clear": async ({ params, respond }) => {
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
      const keepText = params.keepText === true;
      const result = await svc.service.clearCanvasCard({ circleId, cardId, keepText });
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

  "circles.outbound.list": async ({ params, respond }) => {
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
    respond(true, { pending: svc.service.pendingOutbound(circleId) }, undefined);
  },

  "circles.outbound.approve": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
      return;
    }
    try {
      respond(true, await svc.service.approvePendingOutbound(id), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.outbound.reject": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
      return;
    }
    try {
      svc.service.rejectPendingOutbound(id);
      respond(true, { ok: true }, undefined);
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
    const kind = typeof params.kind === "string" ? params.kind : "";
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    // Three shapes: {circleId, cardId, slot} = B2 slice pre-fill for a canvas
    // card; {circleId, cardId, kind:'study'} = Phase 4b personal study aid
    // (renders to this human only, never publishable); {circleId} alone =
    // chat-scoped "Ask my agent" reply draft (no summon message posted).
    if (kind === "study") {
      if (!cardId || slot) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "study drafts take cardId and no slot"),
        );
        return;
      }
    } else if ((cardId && !slot) || (!cardId && slot)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cardId and slot go together"),
      );
      return;
    }
    try {
      respond(
        true,
        kind === "study"
          ? svc.service.requestAgentStudyDraft({ circleId, cardId })
          : cardId
            ? svc.service.requestAgentSliceDraft({ circleId, cardId, slot })
            : svc.service.requestAgentReplyDraft({ circleId }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  // Phase 4b: record one quiz result from the study lens. The human's own tap;
  // member-own data — nothing fans out. Slot charset is enforced in study.ts
  // (it can land in a future trusted prompt frame via the mastery summary).
  "circles.study.record": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    const slot = typeof params.slot === "string" ? params.slot : "";
    const correct = params.correct === true;
    if (!circleId || !cardId || !slot || typeof params.correct !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, cardId, slot, correct required"),
      );
      return;
    }
    try {
      respond(
        true,
        { state: svc.service.recordStudyResult({ circleId, cardId, slot, correct }) },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  // Phase 4b: this member's own mastery state (for due badges + the lens).
  "circles.study.state": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : undefined;
    if (!circleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "circleId required"));
      return;
    }
    respond(true, { sections: svc.service.studyState(circleId, cardId) }, undefined);
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

  // PLAN-38 P1(b): the canvas sandbox. `state` is the fold + node-local view
  // (our private enrollment never leaves the node except into our own UI);
  // frame/enroll/move/close are human acts that become ordinary signed
  // events; pause/resume touch only the local enrollment ledger.
  "circles.sandbox.state": async ({ params, respond }) => {
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
    respond(true, svc.service.sandboxState(circleId), undefined);
  },

  // ONE consent act: "my agent works this circle's canvas." Replaces the old
  // frame + per-card enroll + practice-seat trio, which were three ceremonies
  // standing between a person and the thing working.
  "circles.sandbox.participation": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const mode = params.mode === "off" || params.mode === "propose" ? params.mode : null;
    if (!circleId || !mode) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, mode ('off'|'propose') required"),
      );
      return;
    }
    try {
      const participation = await svc.service.setCanvasParticipation({
        circleId,
        mode,
        turnBudget: typeof params.turnBudget === "number" ? params.turnBudget : undefined,
        tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget : undefined,
        guidance: typeof params.guidance === "string" ? params.guidance : undefined,
      });
      respond(true, { participation }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.sandbox.move": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    const kind =
      params.kind === "constraint" ||
      params.kind === "option.add" ||
      params.kind === "vote" ||
      params.kind === "pass"
        ? params.kind
        : null;
    if (!circleId || !cardId || !kind) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "circleId, cardId, kind ('constraint'|'option.add'|'vote'|'pass') required",
        ),
      );
      return;
    }
    try {
      const result = await svc.service.postSandboxMove({
        circleId,
        cardId,
        kind,
        text: typeof params.text === "string" ? params.text : undefined,
        optionId: typeof params.optionId === "string" ? params.optionId : undefined,
        label: typeof params.label === "string" ? params.label : undefined,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.sandbox.steer": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const guidance = typeof params.guidance === "string" ? params.guidance : null;
    if (!circleId || guidance === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, guidance required"),
      );
      return;
    }
    try {
      respond(true, { participation: svc.service.steerSandbox({ circleId, guidance }) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.sandbox.pause": async ({ params, respond }) => {
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
      svc.service.pauseSandbox({
        circleId,
        reason: typeof params.reason === "string" ? params.reason : undefined,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "circles.sandbox.resume": async ({ params, respond }) => {
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
    svc.service.resumeSandbox({ circleId });
    respond(true, { ok: true }, undefined);
  },

  "circles.sandbox.close": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const cardId = typeof params.cardId === "string" ? params.cardId : "";
    // The UI finishes as 'done' (ratified) or 'human' (someone pulled the
    // plug); detector reasons (cap, no_progress, budget) are machine-set.
    const reason = params.reason === "done" || params.reason === "human" ? params.reason : null;
    if (!circleId || !cardId || !reason) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "circleId, cardId, reason ('done'|'human') required",
        ),
      );
      return;
    }
    try {
      respond(true, await svc.service.closeSandboxSession({ circleId, cardId, reason }), undefined);
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
        // paints the whole conversation state. Pinned messages are resolved
        // server-side by envelope id (no window limit — review F4).
        annotations: {
          ...svc.service.messageAnnotations(circleId),
          pinnedMessages: svc.service.pinnedMessages(circleId),
        },
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

  "circles.message.delete": async ({ params, respond }) => {
    const svc = await getService();
    if (!svc.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, svc.error));
      return;
    }
    const circleId = typeof params.circleId === "string" ? params.circleId : "";
    const envelopeId = typeof params.envelopeId === "string" ? params.envelopeId : "";
    if (!circleId || !envelopeId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "circleId, envelopeId required"),
      );
      return;
    }
    try {
      // Own message -> retraction event on our chain (honest peers tombstone
      // too); someone else's -> node-local hide. The service decides by
      // authorship; the response's `scope` says which happened.
      respond(true, await svc.service.deleteMessage({ circleId, envelopeId }), undefined);
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
