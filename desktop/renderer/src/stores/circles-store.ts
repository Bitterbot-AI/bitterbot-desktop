import { create } from "zustand";
import {
  HISTORY_PAGE,
  mergeMessages,
  type AgentDraft,
  type CanvasCard,
  type Circle,
  type CircleMessage,
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

interface CirclesState {
  status: CirclesStatus | null;
  circles: Circle[];
  activeCircleId: string | null;
  messagesByCircle: Record<string, CircleMessage[]>;
  annotationsByCircle: Record<string, MessageAnnotations>;
  /**
   * The circle's read marker AS IT STOOD WHEN THE HUMAN OPENED IT — the "New"
   * divider anchors here and must not slide while they read (markRead bumps
   * the live marker the moment the circle is opened).
   */
  readFrontierByCircle: Record<string, number>;
  /** History paging: true once a short page proved there is nothing older. */
  historyExhaustedByCircle: Record<string, boolean>;
  cardsByCircle: Record<string, CanvasCard[]>;
  removedByCircle: Record<string, RemovedCanvasCard[]>;
  sandboxByCircle: Record<string, SandboxState>;
  draftsByCircle: Record<string, AgentDraft[]>;
  /** Phase 4b study state, keyed `${circleId}:${cardId}`. */
  studyByCard: Record<string, StudySectionState[]>;
  outboundByCircle: Record<string, PendingOutbound[]>;
  loading: boolean;
  notice: string | null;
  /** §3.2.8: a chat item's card chip focuses its card on the canvas. */
  focusCardId: string | null;

  refresh: () => Promise<void>;
  selectCircle: (circleId: string) => void;
  loadMessages: (circleId: string) => Promise<void>;
  /** Prepend the next (older) history page; resolves to how many were added. */
  loadOlderMessages: (circleId: string) => Promise<number>;
  loadCards: (circleId: string) => Promise<void>;
  setFocusCard: (cardId: string | null) => void;
  removeCard: (circleId: string, cardId: string) => Promise<boolean>;
  clearCard: (circleId: string, cardId: string, keepText: boolean) => Promise<boolean>;
  undoRemoveCard: (circleId: string, removed: RemovedCanvasCard) => Promise<boolean>;
  loadSandbox: (circleId: string) => Promise<void>;
  /** The one consent act: does my agent work this circle's canvas. */
  setCanvasParticipation: (
    circleId: string,
    mode: "off" | "propose",
    opts?: { guidance?: string; turnBudget?: number },
  ) => Promise<boolean>;
  /** The human composer: post a move by hand. */
  sandboxMove: (
    circleId: string,
    cardId: string,
    kind: "constraint" | "option.add" | "vote" | "pass",
    opts?: { text?: string; optionId?: string; label?: string },
  ) => Promise<boolean>;
  /** Steer: your words to your own agent (private, never posted anywhere). */
  steerAgent: (circleId: string, guidance: string) => Promise<boolean>;
  pauseSandbox: (circleId: string) => Promise<boolean>;
  resumeSandbox: (circleId: string) => Promise<boolean>;
  closeSandbox: (circleId: string, cardId: string, reason: "done" | "human") => Promise<boolean>;
  loadDrafts: (circleId: string) => Promise<void>;
  loadOutbound: (circleId: string) => Promise<void>;
  approveOutbound: (circleId: string, id: string) => Promise<boolean>;
  rejectOutbound: (circleId: string, id: string) => Promise<boolean>;
  requestSliceDraft: (circleId: string, cardId: string, slot: string) => Promise<boolean>;
  /** Phase 4b: ask my agent for a personal study aid from this card (private; never publishable). */
  requestStudyDraft: (circleId: string, cardId: string) => Promise<boolean>;
  loadStudyState: (circleId: string, cardId: string) => Promise<void>;
  /** Phase 4b: record one quiz tap; refreshes the card's study state. */
  recordStudy: (
    circleId: string,
    cardId: string,
    slot: string,
    correct: boolean,
  ) => Promise<boolean>;
  /** Chat-scoped "Ask my agent": a private reply draft, no summon message posted. */
  requestChatDraft: (circleId: string) => Promise<boolean>;
  publishDraft: (circleId: string, draftId: string, text: string) => Promise<boolean>;
  discardDraft: (circleId: string, draftId: string) => Promise<boolean>;
  send: (circleId: string, text: string, replyTo?: string) => Promise<boolean>;
  react: (circleId: string, envelopeId: string, emojis: string[]) => Promise<boolean>;
  setPinned: (circleId: string, envelopeId: string, pinned: boolean) => Promise<boolean>;
  deleteMessage: (
    circleId: string,
    envelopeId: string,
    expectPropagation?: boolean,
  ) => Promise<boolean>;
  putCard: (
    circleId: string,
    title: string,
    text: string,
    cardId?: string,
    cardType?: string,
  ) => Promise<boolean>;
  putDecision: (circleId: string, question: string, options: string[]) => Promise<boolean>;
  putStudyGuide: (circleId: string, title: string, sections: string[]) => Promise<boolean>;
  putSlice: (
    circleId: string,
    cardId: string,
    slot: string,
    value: string,
    note: string,
  ) => Promise<boolean>;
  vote: (circleId: string, cardId: string, option: string, note: string) => Promise<boolean>;
  markRead: (circleId: string) => void;
  unfreeze: (circleId: string) => Promise<boolean>;
  removeMember: (circleId: string, memberPubkey: string) => Promise<boolean>;
  renameCircle: (circleId: string, name: string) => Promise<boolean>;
  /** Verified preview of an invite code (who is REALLY asking) before joining. */
  inviteInfo: (code: string) => Promise<{
    circleName: string;
    inviterName: string | null;
    inviterPubkey: string;
    /** Your label for the verified signer when you already know them. */
    knownAs?: string | null;
  } | null>;
  /** One-tap join for an invite code detected in a message. */
  joinInvite: (code: string) => Promise<boolean>;
  archiveCircle: (circleId: string) => Promise<boolean>;
  unarchiveCircle: (circleId: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  setPetname: (memberPubkey: string, petname: string) => Promise<boolean>;
  setSelfName: (name: string) => Promise<boolean>;
  setNotice: (notice: string | null) => void;
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
  cardsByCircle: {},
  removedByCircle: {},
  focusCardId: null,
  sandboxByCircle: {},
  draftsByCircle: {},
  studyByCard: {},
  outboundByCircle: {},
  loading: true,
  notice: null,

  setNotice: (notice) => set({ notice }),

  refresh: async () => {
    try {
      const status = await request<CirclesStatus>("circles.status", {});
      if (!status.enabled) {
        set({ status, circles: [], loading: false });
        return;
      }
      const list = await request<{ circles: Circle[] }>("circles.list", {});
      const circles = list.circles ?? [];
      // Keep the current selection if it still exists; else pick the first.
      const prev = get().activeCircleId;
      // AUTO-selection never lands on an archived circle — its tile is hidden
      // (Phase B), so the user would be stuck on a chat with no tile. An
      // EXPLICIT selection of an archived circle (prev, via the rail's
      // archive toggle) is respected: the rail force-reveals the archived
      // section while one is active. All-archived → null (empty state).
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
      if (activeCircleId) {
        void get().loadMessages(activeCircleId);
        void get().loadCards(activeCircleId);
        void get().loadSandbox(activeCircleId);
        void get().loadDrafts(activeCircleId);
        void get().loadOutbound(activeCircleId);
        get().markRead(activeCircleId); // the circle on screen is, by definition, read
      }
    } catch (err) {
      set({ notice: String(err), loading: false });
    }
  },

  selectCircle: (circleId) => {
    // Re-clicking the circle you're already reading must NOT re-freeze the
    // "New" divider — refresh() marks it read every poll, so a re-freeze
    // would erase the line mid-read (review a324d9d #4a).
    if (get().activeCircleId === circleId) {
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
    }
  },

  approveOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.approve", { id });
      await Promise.all([get().loadOutbound(circleId), get().loadMessages(circleId)]);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  rejectOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.reject", { id });
      await get().loadOutbound(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
    }
  },

  setFocusCard: (cardId) => set({ focusCardId: cardId }),

  removeCard: async (circleId, cardId) => {
    try {
      await request("circles.canvas.remove", { circleId, cardId });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      if (!methodUnavailable("circles.sandbox.state", err)) set({ notice: String(err) });
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
      set({ notice: String(err) });
      return false;
    }
  },

  sandboxMove: async (circleId, cardId, kind, opts) => {
    try {
      await request("circles.sandbox.move", { circleId, cardId, kind, ...opts });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  steerAgent: async (circleId, guidance) => {
    try {
      await request("circles.sandbox.steer", { circleId, guidance });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  pauseSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.pause", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  resumeSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.resume", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  closeSandbox: async (circleId, cardId, reason) => {
    try {
      await request("circles.sandbox.close", { circleId, cardId, reason });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
      return false;
    }
  },

  removeMember: async (circleId, memberPubkey) => {
    try {
      await request("circles.member.remove", { circleId, memberPubkey });
      await get().refresh(); // roster shrinks everywhere it shows
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
      return null;
    }
  },

  joinInvite: async (code) => {
    try {
      await request("circles.join", { code });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
      return false;
    }
  },

  unarchiveCircle: async (circleId) => {
    try {
      await request("circles.unarchive", { circleId });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
      return false;
    }
  },

  markRead: (circleId) => {
    // Optimistically clear the badge AND bump the local read marker — the
    // next selectCircle freeze must see this visit, not the pre-visit marker
    // the 20s-stale circles.list still carries. Persist fire-and-forget.
    const now = Date.now();
    set((s) => ({
      circles: s.circles.map((c) =>
        c.circleId === circleId
          ? { ...c, unread: 0, lastReadAt: Math.max(c.lastReadAt ?? 0, now) }
          : c,
      ),
    }));
    void request("circles.markRead", { circleId }).catch(() => {});
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
      set({ notice: String(err) });
      return 0;
    }
  },

  react: async (circleId, envelopeId, emojis) => {
    try {
      await request("circles.react", { circleId, envelopeId, emojis });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  setPinned: async (circleId, envelopeId, pinned) => {
    try {
      await request("circles.pin", { circleId, envelopeId, pinned });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
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
      set({ notice: String(err) });
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
      set({ notice: String(err) });
      return false;
    }
  },
}));
