import { create } from "zustand";
import {
  HISTORY_PAGE,
  mergeMessages,
  type AgentDraft,
  type CanvasCard,
  type Circle,
  type CircleMessage,
  type CirclesState,
  type CirclesStatus,
  type MessageAnnotations,
  type PendingOutbound,
  type RemovedCanvasCard,
  type SandboxState,
  type StudySectionState,
} from "./circles-types";
import { useGatewayStore } from "./gateway-store";

// Data shapes + pure helpers live in circles-types.ts (file-size split);
// re-exported here so existing `from "../../stores/circles-store"` imports
// keep working unchanged.
export * from "./circles-types";

// PLAN-36 Phase A (redesign): the per-circle keyed store the Discord-style
// CirclesView is built on. Replaces PeopleView's ad-hoc local useState. Keeps
// one message cache per circle so switching circles is instant and A2 (unread
// badges) has a home. All state rides the existing circles.* gateway RPCs — no
// new protocol.

// Version-skew degradation: a gateway older than this UI doesn't know the
// newer circles.* RPCs. Remember per-method, stop calling, and never surface
// the failure as a notice — the feature simply stays absent until the
// gateway is rebuilt. (The gateway-store already suppresses the toast.)
const unsupportedMethods = new Set<string>();
/** Test seam: module state must not leak between renderer tests. */
export function resetUnsupportedMethodsForTests(): void {
  unsupportedMethods.clear();
}
function methodUnavailable(method: string, err: unknown): boolean {
  if (unsupportedMethods.has(method)) return true;
  if (String(err).includes("unknown method")) {
    unsupportedMethods.add(method);
    return true;
  }
  return false;
}

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  return useGatewayStore.getState().request<T>(method, params);
}

export const useCirclesStore = create<CirclesState>((set, get) => ({
  status: null,
  circles: [],
  activeCircleId: null,
  messagesByCircle: {},
  annotationsByCircle: {},
  readFrontierByCircle: {},
  historyExhaustedByCircle: {},
  readSyncByCircle: {},
  cardsByCircle: {},
  removedByCircle: {},
  focusCardId: null,
  sandboxByCircle: {},
  draftsByCircle: {},
  studyByCard: {},
  outboundByCircle: {},
  loading: true,
  notice: null,
  noticeLevel: "info",

  // setNotice is the INFO channel (tips, confirmations); error sites set the
  // level explicitly so a failure can never wear the friendly blue.
  setNotice: (notice) => set({ notice, noticeLevel: "info" }),

  // The CHEAP half (status + list + selection): what the app-wide background
  // sync runs. It never fires per-circle pane loads for a circle nobody is
  // viewing, never marks read, and never writes a user-facing notice — a
  // headless loop must not paint persistent error banners (d638276 review #7).
  refreshList: async () => {
    try {
      const status = await request<CirclesStatus>("circles.status", {});
      if (!status.enabled) {
        set({ status, circles: [], loading: false });
        return { ok: true as const };
      }
      const list = await request<{ circles: Circle[] }>("circles.list", {});
      // markRead ack guard (review #5): a list computed before our markRead
      // reached the server (or after a dropped markRead) must not resurrect
      // the badge on a circle the human already opened. Local wins until the
      // server marker catches up.
      const sync = get().readSyncByCircle;
      const circles = (list.circles ?? []).map((c) => {
        const local = sync[c.circleId];
        return local && (c.lastReadAt ?? 0) < local ? { ...c, unread: 0, lastReadAt: local } : c;
      });
      // Keep the current selection if it still exists; else pick the first.
      // AUTO-selection never lands on an archived circle — its tile is hidden
      // (Phase B), so the user would be stuck on a chat with no tile. An
      // EXPLICIT selection of an archived circle (prev, via the rail's
      // archive toggle) is respected: the rail force-reveals the archived
      // section while one is active. All-archived → null (empty state).
      const prev = get().activeCircleId;
      const prevExists = prev && circles.some((c) => c.circleId === prev);
      const activeCircleId = prevExists
        ? prev
        : (circles.find((c) => c.status !== "archived")?.circleId ?? null);
      set({ status, circles, activeCircleId, loading: false });
      // First activation (boot / the previous circle vanished): freeze the
      // "New" divider frontier from the marker BEFORE markRead bumps it.
      // Re-polls of the already-active circle must NOT re-freeze — the line
      // would slide down while the human reads. Version skew: an older
      // gateway omits lastReadAt entirely — leave the frontier unset (no
      // divider) rather than pinning a permanent "New" above all history.
      if (activeCircleId && get().readFrontierByCircle[activeCircleId] === undefined) {
        const c = circles.find((x) => x.circleId === activeCircleId);
        if (typeof c?.lastReadAt === "number") {
          set((s) => ({
            readFrontierByCircle: {
              ...s.readFrontierByCircle,
              [activeCircleId]: c.lastReadAt as number,
            },
          }));
        }
      }
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: String(err) };
    }
  },

  // The FULL refresh the Circles view runs: list + the active circle's panes.
  refresh: async () => {
    const res = await get().refreshList();
    if (!res.ok) {
      set({ notice: res.error ?? "refresh failed", noticeLevel: "error", loading: false });
      return;
    }
    const activeCircleId = get().activeCircleId;
    if (activeCircleId) {
      void get().loadMessages(activeCircleId);
      void get().loadCards(activeCircleId);
      void get().loadSandbox(activeCircleId);
      void get().loadDrafts(activeCircleId);
      void get().loadOutbound(activeCircleId);
      // NOTE: refresh() deliberately does NOT markRead — the Circles view
      // marks read on mount/active-change/select/inbound-event.
    }
  },

  selectCircle: (circleId) => {
    // Re-clicking the circle you're already reading must NOT re-freeze the
    // "New" divider (review a324d9d #4a) — but it DOES mark read: it's the
    // one affordance a user reaches for when a badge looks stuck (d638276
    // review #4).
    if (get().activeCircleId === circleId) {
      get().markRead(circleId);
      void get().loadMessages(circleId);
      return;
    }
    // Re-freeze the divider frontier on every explicit SWITCH: messages that
    // arrived since you last had this circle open are "New" again. markRead
    // bumps lastReadAt locally too, so hopping A→B→A inside one poll window
    // freezes at your actual visit, not a stale pre-visit marker (#4b).
    // Older gateways omit lastReadAt — leave the frontier unset (no divider).
    const c = get().circles.find((x) => x.circleId === circleId);
    set((s) => ({
      activeCircleId: circleId,
      readFrontierByCircle:
        typeof c?.lastReadAt === "number"
          ? { ...s.readFrontierByCircle, [circleId]: c.lastReadAt }
          : s.readFrontierByCircle,
    }));
    void get().loadMessages(circleId);
    void get().loadCards(circleId);
    void get().loadSandbox(circleId);
    void get().loadDrafts(circleId);
    void get().loadOutbound(circleId);
    get().markRead(circleId);
  },

  loadDrafts: async (circleId) => {
    if (unsupportedMethods.has("circles.drafts.list")) return;
    try {
      const res = await request<{ drafts: AgentDraft[] }>("circles.drafts.list", { circleId });
      set((s) => ({ draftsByCircle: { ...s.draftsByCircle, [circleId]: res.drafts ?? [] } }));
    } catch (err) {
      if (methodUnavailable("circles.drafts.list", err)) return;
      set({ notice: String(err), noticeLevel: "error" });
    }
  },

  loadOutbound: async (circleId) => {
    if (unsupportedMethods.has("circles.outbound.list")) return;
    try {
      const res = await request<{ pending: PendingOutbound[] }>("circles.outbound.list", {
        circleId,
      });
      set((s) => ({ outboundByCircle: { ...s.outboundByCircle, [circleId]: res.pending ?? [] } }));
    } catch (err) {
      if (methodUnavailable("circles.outbound.list", err)) return;
      set({ notice: String(err), noticeLevel: "error" });
    }
  },

  approveOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.approve", { id });
      await Promise.all([get().loadOutbound(circleId), get().loadMessages(circleId)]);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  rejectOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.reject", { id });
      await get().loadOutbound(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  requestSliceDraft: async (circleId, cardId, slot) => {
    try {
      // B2: ask my agent to pre-fill MY slot on this card. The draft comes
      // back via the "circles" nudge → loadDrafts; publishing a slice draft
      // ships through circles.canvas.slice on the server.
      await request("circles.drafts.request", { circleId, cardId, slot });
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  requestStudyDraft: async (circleId, cardId) => {
    try {
      // Phase 4b: the agent builds a private study aid (quiz + gap map) from
      // the shared card, tuned to MY mastery state. Renders to me only; the
      // server has no publish path for study drafts.
      await request("circles.drafts.request", { circleId, cardId, kind: "study" });
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  loadStudyState: async (circleId, cardId) => {
    try {
      const res = await request<{ sections: StudySectionState[] }>("circles.study.state", {
        circleId,
        cardId,
      });
      set((s) => ({
        studyByCard: { ...s.studyByCard, [`${circleId}:${cardId}`]: res.sections ?? [] },
      }));
    } catch {
      // Older gateway without Phase 4b: no badges, everything else works.
    }
  },

  recordStudy: async (circleId, cardId, slot, correct) => {
    try {
      await request("circles.study.record", { circleId, cardId, slot, correct });
      await get().loadStudyState(circleId, cardId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  requestChatDraft: async (circleId) => {
    try {
      // Nothing is posted to the circle — the agent drafts privately and the
      // card lands in the quiet tray for review/publish.
      await request("circles.drafts.request", { circleId });
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  publishDraft: async (circleId, draftId, text) => {
    if (!text.trim()) return false;
    try {
      await request("circles.drafts.publish", { draftId, text: text.trim() });
      // A reply draft lands in messages; a slice draft lands on the canvas.
      await Promise.all([
        get().loadDrafts(circleId),
        get().loadMessages(circleId),
        get().loadCards(circleId),
      ]);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      // §3.2.9: a failed publish may have discarded the draft server-side (its
      // card was deleted). Reload both so a now-dead proposal leaves the strip.
      await Promise.all([get().loadDrafts(circleId), get().loadCards(circleId)]);
      return false;
    }
  },

  discardDraft: async (circleId, draftId) => {
    try {
      await request("circles.drafts.discard", { draftId });
      await get().loadDrafts(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      await get().loadDrafts(circleId); // draft may already be gone; drop it
      return false;
    }
  },

  loadCards: async (circleId) => {
    try {
      const res = await request<{ cards: CanvasCard[]; removed?: RemovedCanvasCard[] }>(
        "circles.canvas.list",
        { circleId },
      );
      set((s) => ({
        cardsByCircle: { ...s.cardsByCircle, [circleId]: res.cards ?? [] },
        removedByCircle: { ...s.removedByCircle, [circleId]: res.removed ?? [] },
      }));
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
    }
  },

  setFocusCard: (cardId) => set({ focusCardId: cardId }),

  removeCard: async (circleId, cardId) => {
    try {
      await request("circles.canvas.remove", { circleId, cardId });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  // §3.2.9: clear = tombstone + fresh card with the same title. The server
  // mints the new card id; a fresh session comes for free.
  clearCard: async (circleId, cardId, keepText) => {
    try {
      await request("circles.canvas.clear", { circleId, cardId, keepText });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  // Undo a removal: re-put the tombstoned card's body under its original id —
  // a later put outwins the tombstone in the fold (undo by construction).
  undoRemoveCard: async (circleId, removed) => {
    try {
      await request("circles.canvas.put", {
        circleId,
        cardId: removed.cardId,
        cardType: removed.cardType,
        title: removed.title,
        text: removed.text,
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  // PLAN-38 P1(b): the canvas sandbox. Version-skew safe: an older gateway
  // without the sandbox RPCs leaves the feature absent, never noisy.
  loadSandbox: async (circleId) => {
    if (unsupportedMethods.has("circles.sandbox.state")) return;
    try {
      const res = await request<Partial<SandboxState>>("circles.sandbox.state", { circleId });
      // Normalize defensively: a gateway of a different vintage answering with
      // an unexpected shape must degrade to "no sessions", never crash the
      // canvas render.
      const state: SandboxState = {
        generationEnabled: res?.generationEnabled === true,
        practicePubkey: typeof res?.practicePubkey === "string" ? res.practicePubkey : null,
        participation: res?.participation ?? null,
        thinkingCardIds: Array.isArray(res?.thinkingCardIds) ? res.thinkingCardIds : [],
        sessions: Array.isArray(res?.sessions) ? res.sessions : [],
      };
      set((s) => ({ sandboxByCircle: { ...s.sandboxByCircle, [circleId]: state } }));
    } catch (err) {
      if (!methodUnavailable("circles.sandbox.state", err))
        set({ notice: String(err), noticeLevel: "error" });
    }
  },

  setCanvasParticipation: async (circleId, mode, opts) => {
    try {
      await request("circles.sandbox.participation", {
        circleId,
        mode,
        guidance: opts?.guidance,
        turnBudget: opts?.turnBudget,
      });
      await get().loadSandbox(circleId);
      await get().refresh(); // a solo circle may have gained the practice bot
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  sandboxMove: async (circleId, cardId, kind, opts) => {
    try {
      await request("circles.sandbox.move", { circleId, cardId, kind, ...opts });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  steerAgent: async (circleId, guidance) => {
    try {
      await request("circles.sandbox.steer", { circleId, guidance });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  pauseSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.pause", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  resumeSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.resume", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  closeSandbox: async (circleId, cardId, reason) => {
    try {
      await request("circles.sandbox.close", { circleId, cardId, reason });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  putCard: async (circleId, title, text, cardId, cardType) => {
    if (!title.trim() && !text.trim()) return false;
    try {
      await request("circles.canvas.put", {
        circleId,
        title: title.trim(),
        text,
        cardId,
        cardType,
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  putDecision: async (circleId, question, options) => {
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || opts.length < 2) return false;
    try {
      // A Decision Card is a card with cardType "decision"; options ride the
      // text field, one per line (a scanned string). Votes are per-member slices.
      await request("circles.canvas.put", {
        circleId,
        cardType: "decision",
        title: question.trim(),
        text: opts.join("\n"),
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  putStudyGuide: async (circleId, title, sections) => {
    const secs = sections.map((s) => s.trim()).filter(Boolean);
    if (!title.trim() || secs.length === 0) return false;
    try {
      // A study guide (C3) is a card with cardType "study"; sections ride the
      // text field, one per line. Each member's per-section contribution is a
      // separate slice (slot = the section's stable id), so the guide ASSEMBLES
      // from everyone's pieces instead of being one author's document.
      await request("circles.canvas.put", {
        circleId,
        cardType: "study",
        title: title.trim(),
        text: secs.join("\n"),
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  putSlice: async (circleId, cardId, slot, value, note) => {
    if (!slot || !value) return false;
    try {
      await request("circles.canvas.slice", { circleId, cardId, slot, value, note });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  vote: async (circleId, cardId, option, note) => {
    return get().putSlice(circleId, cardId, "vote", option, note);
  },

  unfreeze: async (circleId) => {
    try {
      await request("circles.unfreeze", { circleId });
      await get().refresh(); // status flips back to active everywhere it shows
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  removeMember: async (circleId, memberPubkey) => {
    try {
      await request("circles.member.remove", { circleId, memberPubkey });
      await get().refresh(); // roster shrinks everywhere it shows
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  renameCircle: async (circleId, name) => {
    try {
      // Node-local: your label for the group; the wire never carries it.
      await request("circles.rename", { circleId, name });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  inviteInfo: async (code) => {
    try {
      return await request<{
        circleName: string;
        inviterName: string | null;
        inviterPubkey: string;
        knownAs?: string | null;
      }>("circles.inviteInfo", { code });
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return null;
    }
  },

  joinInvite: async (code) => {
    try {
      await request("circles.join", { code });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  setAgentDrafts: async (enabled) => {
    try {
      const res = await request<{ enabled: boolean; posture: string }>("circles.agentDrafts.set", {
        enabled,
      });
      await get().refreshList(); // the posture chip reads the roster's self row
      if (enabled && res.posture === "off") {
        set({
          notice:
            "Agent drafts are on, but no draft model is wired on this node — summons stay off until one is configured.",
          noticeLevel: "info",
        });
      }
      return true;
    } catch (err) {
      if (methodUnavailable("circles.agentDrafts.set", err)) {
        set({
          notice:
            "This gateway is older than the UI — change circles.agentDrafts.enabled in the config file instead.",
          noticeLevel: "info",
        });
        return false;
      }
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  archiveCircle: async (circleId) => {
    try {
      await request("circles.archive", { circleId });
      if (get().activeCircleId === circleId) set({ activeCircleId: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  unarchiveCircle: async (circleId) => {
    try {
      await request("circles.unarchive", { circleId });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  deleteCircle: async (circleId) => {
    try {
      await request("circles.delete", { circleId });
      if (get().activeCircleId === circleId) set({ activeCircleId: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  setPetname: async (memberPubkey, petname) => {
    try {
      // Empty label clears it; the server treats blank as clear too.
      const method = petname.trim() ? "circles.petname.set" : "circles.petname.clear";
      await request(method, { memberPubkey, petname: petname.trim() });
      await get().refresh(); // the new label shows everywhere this person appears
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  setSelfName: async (name) => {
    if (!name.trim()) return false;
    try {
      await request("circles.self.setName", { name: name.trim() });
      await get().refresh(); // status.displayName + how you appear locally
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  markRead: (circleId) => {
    // Optimistically clear the badge AND bump the local read marker — the
    // next selectCircle freeze must see this visit, not the pre-visit marker
    // the 45s-stale circles.list still carries. readSyncByCircle records the
    // act so refreshList can guard against a racing/stale list resurrecting
    // the badge, and the persist retries a couple of times instead of one
    // swallowed fire-and-forget (d638276 review #5).
    const now = Date.now();
    set((s) => ({
      readSyncByCircle: { ...s.readSyncByCircle, [circleId]: now },
      circles: s.circles.map((c) =>
        c.circleId === circleId
          ? { ...c, unread: 0, lastReadAt: Math.max(c.lastReadAt ?? 0, now) }
          : c,
      ),
    }));
    const push = (attempt: number) => {
      void request("circles.markRead", { circleId }).catch(() => {
        if (attempt < 3) setTimeout(() => push(attempt + 1), attempt * 5000);
      });
    };
    push(1);
  },

  loadMessages: async (circleId) => {
    try {
      const res = await request<{ messages: CircleMessage[]; annotations?: MessageAnnotations }>(
        "circles.messages",
        { circleId },
      );
      // The server returns the recent window newest-first (DESC LIMIT); the
      // chat renders chronologically, so store it oldest-first — newest lands
      // at the bottom of the thread under the auto-scroll. MERGE with what's
      // already loaded instead of replacing: older pages fetched via
      // loadOlderMessages must survive the 20s poll. The fresh window wins on
      // id collisions (tombstones, delivery-status flips).
      const window = [...(res.messages ?? [])].reverse();
      set((s) => {
        const prevMsgs = s.messagesByCircle[circleId] ?? [];
        const nextMsgs = mergeMessages(prevMsgs, window);
        // Annotation reference stability: idle polls return equal content in
        // fresh objects; keep the old reference so subscribers don't re-render.
        const nextAnn = res.annotations ?? { reactions: {}, pins: [] };
        const prevAnn = s.annotationsByCircle[circleId];
        const annChanged = !prevAnn || JSON.stringify(prevAnn) !== JSON.stringify(nextAnn);
        if (nextMsgs === prevMsgs && !annChanged && circleId in s.messagesByCircle) return s;
        return {
          messagesByCircle: { ...s.messagesByCircle, [circleId]: nextMsgs },
          annotationsByCircle: {
            ...s.annotationsByCircle,
            [circleId]: annChanged ? nextAnn : prevAnn,
          },
        };
      });
    } catch (err) {
      // Never leave the timeline on the skeleton forever: an unloaded circle
      // whose fetch failed degrades to an honest empty state + the notice.
      set((s) => ({
        notice: String(err),
        noticeLevel: "error" as const,
        messagesByCircle: s.messagesByCircle[circleId]
          ? s.messagesByCircle
          : { ...s.messagesByCircle, [circleId]: [] },
      }));
    }
  },

  loadOlderMessages: async (circleId) => {
    const s = get();
    if (s.historyExhaustedByCircle[circleId]) return 0;
    const existing = s.messagesByCircle[circleId] ?? [];
    const oldest = existing[0];
    if (!oldest) return 0;
    const PAGE = HISTORY_PAGE;
    try {
      const res = await request<{ messages: CircleMessage[] }>("circles.messages", {
        circleId,
        // Keyset cursor: ts + id tiebreak, so a burst sharing the boundary
        // millisecond is never skipped (review a324d9d #1).
        before: oldest.createdAt,
        beforeId: oldest.messageId,
        limit: PAGE,
      });
      const page = [...(res.messages ?? [])].reverse();
      let added = 0;
      set((st) => {
        const current = st.messagesByCircle[circleId] ?? [];
        const merged = mergeMessages(current, page);
        added = merged.length - current.length;
        return {
          messagesByCircle: { ...st.messagesByCircle, [circleId]: merged },
          // A short page means the top of history. An older gateway ignores
          // `before` and echoes the recent window (all duplicates, added=0) —
          // treat that as exhausted too, or the button becomes a no-op loop.
          historyExhaustedByCircle: {
            ...st.historyExhaustedByCircle,
            [circleId]:
              page.length < PAGE || added === 0
                ? true
                : (st.historyExhaustedByCircle[circleId] ?? false),
          },
        };
      });
      return added;
    } catch (err) {
      // A transient RPC failure is NOT the top of history — latching
      // exhausted here would permanently hide the affordance (review #5).
      set({ notice: String(err), noticeLevel: "error" });
      return 0;
    }
  },

  react: async (circleId, envelopeId, emojis) => {
    try {
      await request("circles.react", { circleId, envelopeId, emojis });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  setPinned: async (circleId, envelopeId, pinned) => {
    try {
      await request("circles.pin", { circleId, envelopeId, pinned });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  deleteMessage: async (circleId, envelopeId, expectPropagation) => {
    try {
      const res = await request<{ scope?: string }>("circles.message.delete", {
        circleId,
        envelopeId,
      });
      // The server decides the real scope (a frozen/archived circle refuses
      // ledger writes); if the human was promised "everyone", correct it.
      if (expectPropagation && res?.scope === "local") {
        set({
          notice:
            "Deleted on this device only — the circle is not accepting writes right now, so friends' copies were not retracted.",
          noticeLevel: "info",
        });
      }
      // Tombstone locally too: loadMessages only refetches the recent window,
      // so a paged-in older message would otherwise stay visibly undeleted on
      // the deleter's own screen for the session (review a324d9d #2).
      set((s) => ({
        messagesByCircle: {
          ...s.messagesByCircle,
          [circleId]: (s.messagesByCircle[circleId] ?? []).map((m) =>
            m.envelopeId === envelopeId
              ? { ...m, deleted: true, deletedByMe: !expectPropagation || res?.scope === "local" }
              : m,
          ),
        },
      }));
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },

  send: async (circleId, text, replyTo) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      await request("circles.send", { circleId, text: trimmed, replyTo });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err), noticeLevel: "error" });
      return false;
    }
  },
}));
