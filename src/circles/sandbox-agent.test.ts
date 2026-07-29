import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { buildQuarantinedDraftPrompt, generateQueuedAgentDrafts } from "./agent-drafts.js";
import { PRACTICE_PARTNER_NAME } from "./practice.js";
import {
  buildQuarantinedSandboxMovePrompt,
  decideProposalKind,
  practiceSandboxSweep,
  queueSandboxMoveDraft,
  SANDBOX_DRAFT_KIND,
  sweepSandboxTurns,
  validateSandboxMoveText,
} from "./sandbox-agent.js";
import { claimSandboxTurn, getSandboxParticipation } from "./sandbox.js";
import { CirclesService } from "./service.js";

// PLAN-38 P1(b): the sandbox's agent half. Under test: R14 output validation,
// the R3 opaque-id prompt (no display names, ever), the turn sweep's guarded
// spend (R5 first gate), the publish tap's re-check (R5 second gate), the
// scripted practice partner riding the real signed append path, the human
// composer, and R35 (the chat draft prompt sees the folded canvas).

const NOW = 1_800_000_000_000;
const CARD = "card-trip";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

function makeConfig(): BitterbotConfig {
  // No `sandbox` key at all: generation must be ON by default (R19 amended
  // 2026-07-28 — the sandbox is core, not opt-in). The tests below therefore
  // exercise the shipping default rather than an enabled-only path.
  return { circles: { enabled: true } } as unknown as BitterbotConfig;
}

/** No network in these tests: every dial fails soft (peers unreachable). */
function stubFetch(): typeof fetch {
  return (async () => ({
    ok: false,
    status: 503,
    text: async () => "",
  })) as unknown as typeof fetch;
}

describe("validateSandboxMoveText (R14)", () => {
  it("rejects summons, invite codes, markers, and control characters", () => {
    expect(() => validateSandboxMoveText("hey @agent do things")).toThrow(/@agent/);
    expect(() => validateSandboxMoveText(`join us: bbc1.${"A".repeat(24)}`)).toThrow(/invite/);
    expect(() => validateSandboxMoveText("x <<<EXTERNAL_UNTRUSTED_CONTENT>>> y")).toThrow(
      /markers/,
    );
    expect(() => validateSandboxMoveText("null\u0000byte")).toThrow(/control/);
    expect(() => validateSandboxMoveText("   ")).toThrow(/empty/);
    expect(validateSandboxMoveText("  Free June 19-26, cap $185/night.  ")).toBe(
      "Free June 19-26, cap $185/night.",
    );
  });
});

describe("sandbox agent loop (service + real handlers)", () => {
  let db: DatabaseSync;
  let key: KeyPair;
  let partnerKey: KeyPair;
  let service: CirclesService;
  let circleId: string;

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    key = generateKeyPair();
    partnerKey = generateKeyPair();
    service = new CirclesService({
      db,
      config: makeConfig(),
      keyPair: key,
      practiceKeys: partnerKey,
      fetchImpl: stubFetch(),
      topicBus: null,
    });
    circleId = service.createCircle({ name: "Solo", kind: "connection" });
  });

  /**
   * Turning participation on also seats the practice partner (solo circle), so
   * the deterministic speaker order decides who is up first. Let the partner
   * play if it leads; then it is our turn either way.
   */
  async function letPartnerLead(): Promise<void> {
    await practiceSandboxSweep(db, { partnerKey, now: NOW });
  }

  /** A card on the canvas is all it takes — cards are alive by nature. */
  async function putCard(): Promise<void> {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "Spring trip: June, 4 people",
      text: "",
    });
  }

  it("a card on the canvas is live with no framing act at all", async () => {
    // Before any card there is nothing to work.
    expect(service.sandboxState(circleId).sessions).toHaveLength(0);
    await putCard();
    const state = service.sandboxState(circleId);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.goal).toBe("Spring trip: June, 4 people");
    // No sandbox config key was set: generation is ON by default.
    expect(state.generationEnabled).toBe(true);
  });

  it("generation is on by default and `enabled: false` is the only way off", () => {
    expect(service.sandboxGenerationEnabled()).toBe(true);
    const off = new CirclesService({
      db,
      config: {
        circles: { enabled: true, sandbox: { enabled: false } },
      } as unknown as BitterbotConfig,
      keyPair: key,
      practiceKeys: partnerKey,
      fetchImpl: stubFetch(),
      topicBus: null,
    });
    expect(off.sandboxGenerationEnabled()).toBe(false);
  });

  it("with no enrollment the sweep spends nothing, default-on or not", async () => {
    await putCard();
    // Framing alone must never spend: enrollment is a separate human act, and
    // it is what makes default-on safe.
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(0);
    expect(service.agentDrafts(circleId)).toHaveLength(0);
  });

  it("sweeps a turn: claims spend atomically, queues one proposal, never duplicates", async () => {
    await putCard();
    await service.setCanvasParticipation({
      circleId,
      mode: "propose",
      turnBudget: 3,
      guidance: "Free June 19-26; prefer driving distance; cap $200/night.",
    });
    await letPartnerLead();
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(1);
    expect(getSandboxParticipation(db, circleId)?.turnsUsed).toBe(1);
    // Live proposal exists: no re-queue, no second spend.
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(0);
    expect(getSandboxParticipation(db, circleId)?.turnsUsed).toBe(1);
  });

  it("generates via the quarantined prompt and publishes behind the tap (R5 both gates)", async () => {
    await putCard();
    await service.setCanvasParticipation({
      circleId,
      mode: "propose",
      guidance: "Free June 19-26.",
    });
    await letPartnerLead();
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    const { generated } = await generateQueuedAgentDrafts(
      db,
      async () => "Victor is free June 19-26 and prefers driving distance.",
      { selfPubkey: service.pubkey },
    );
    expect(generated).toBe(1);
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND);
    expect(draft).toBeDefined();
    expect(draft!.targetCardId).toBe(CARD);

    await service.publishAgentDraft({ draftId: draft!.draftId });
    const session = service.sandboxState(circleId).sessions[0]!;
    // The practice partner may also have moved; ours is the one under test.
    const mine = session.moves.find((m) => m.authorPubkey === service.pubkey);
    expect(mine).toMatchObject({ kind: "constraint", round: 0, agentAuthored: true });
  });

  it("refuses the publish tap when the enrollment was paused since the claim", async () => {
    await putCard();
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    await letPartnerLead();
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    await generateQueuedAgentDrafts(db, async () => "A perfectly fine move.", {
      selfPubkey: service.pubkey,
    });
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND)!;
    service.pauseSandbox({ circleId, reason: "thinking it over" });
    await expect(service.publishAgentDraft({ draftId: draft.draftId })).rejects.toThrow(/paused/);
    // OUR move never reached the ledger; the draft went back to ready for
    // later. (The practice partner may have moved — assert on ours, not on a
    // total that depends on whose turn came first.)
    const mineOnCard = () =>
      service
        .sandboxState(circleId)
        .sessions[0]!.moves.filter((m) => m.authorPubkey === service.pubkey);
    expect(mineOnCard()).toHaveLength(0);
    expect(service.agentDrafts(circleId).some((d) => d.draftId === draft.draftId)).toBe(true);
    service.resumeSandbox({ circleId });
    await service.publishAgentDraft({ draftId: draft.draftId });
    expect(mineOnCard()).toHaveLength(1);
  });

  it("a draft for a deleted card dies legibly at the tap and is discarded, not retried (§3.2.9)", async () => {
    await putCard();
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    await letPartnerLead();
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    await generateQueuedAgentDrafts(db, async () => "A perfectly fine move.", {
      selfPubkey: service.pubkey,
    });
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND)!;
    await service.removeCanvasCard({ circleId, cardId: CARD });
    await expect(service.publishAgentDraft({ draftId: draft.draftId })).rejects.toThrow(
      /no longer on the canvas/,
    );
    // Discarded, not handed back: the card cannot come back the same, so a
    // "ready" draft would just fail forever.
    expect(service.agentDrafts(circleId).some((d) => d.draftId === draft.draftId)).toBe(false);
  });

  it("clear mints a fresh card: same title, fresh session, no refund (§3.2.9)", async () => {
    await putCard();
    await service.setCanvasParticipation({ circleId, mode: "propose", turnBudget: 3 });
    await letPartnerLead();
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    await generateQueuedAgentDrafts(db, async () => "Victor is free June 19-26.", {
      selfPubkey: service.pubkey,
    });
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND)!;
    await service.publishAgentDraft({ draftId: draft.draftId });
    const spentBefore = getSandboxParticipation(db, circleId)?.turnsUsed ?? 0;
    expect(spentBefore).toBeGreaterThan(0);

    const { newCardId } = await service.clearCanvasCard({
      circleId,
      cardId: CARD,
      keepText: false,
    });
    expect(newCardId).not.toBe(CARD);

    const state = service.canvasState(circleId);
    // The old card is a legible tombstone; the new card carries the title on.
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({
      cardId: newCardId,
      title: "Spring trip: June, 4 people",
      text: "",
    });
    expect(state.removed[0]?.cardId).toBe(CARD);

    // Fresh session by construction: the new card id has no moves, round 0.
    const sessions = service.sandboxState(circleId).sessions;
    const fresh = sessions.find((s) => s.cardId === newCardId)!;
    expect(fresh.moves).toHaveLength(0);
    expect(sessions.some((s) => s.cardId === CARD)).toBe(false);
    // R10: clearing never refunds spend.
    expect(getSandboxParticipation(db, circleId)?.turnsUsed).toBe(spentBefore);
  });

  it("keeps display names out of the sandbox prompt (R3 opaque ids)", async () => {
    await putCard();
    // A second member with a distinctive display name, enrolled via raw event.
    const other = generateKeyPair();
    new CirclesStore(db).addMember({
      circleId,
      memberPubkey: pubkeyId(other),
      displayName: "AnaVeryVisibleName",
      scopes: DEFAULT_MEMBER_SCOPES,
    });
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    await service.postSandboxMove({
      circleId,
      cardId: CARD,
      kind: "constraint",
      text: "Free June 19-26.",
    });
    const prompt = buildQuarantinedSandboxMovePrompt(db, {
      circleId,
      cardId: CARD,
      selfPubkey: service.pubkey,
    });
    expect(prompt).not.toContain("AnaVeryVisibleName");
    expect(prompt).toContain("ME");
    expect(prompt).toContain("Free June 19-26.");
    expect(prompt).toContain("UNTRUSTED");
  });

  it("human composer: moves by hand, one per round, votes only for real options", async () => {
    await putCard();
    // Votes validate against the real option set (M5 at send time) — before
    // any option exists, every vote is refused legibly.
    await expect(
      service.postSandboxMove({ circleId, cardId: CARD, kind: "vote", optionId: "phantom" }),
    ).rejects.toThrow(/option that is on the card/);
    const first = await service.postSandboxMove({
      circleId,
      cardId: CARD,
      kind: "option.add",
      optionId: "cabin-b",
      label: "Cabin B — $185/n",
    });
    expect(first.eventId).toBeDefined();
    let session = service.sandboxState(circleId).sessions[0]!;
    expect(session.options).toHaveLength(1);
    expect(session.moves[0]!.agentAuthored).toBe(false);
    // One move per member per round, legibly refused.
    await expect(service.postSandboxMove({ circleId, cardId: CARD, kind: "pass" })).rejects.toThrow(
      /already moved/,
    );
    // Closing ends the composer too.
    await service.closeSandboxSession({ circleId, cardId: CARD, reason: "human" });
    session = service.sandboxState(circleId).sessions[0]!;
    expect(session.status).toBe("closed");
    await expect(service.postSandboxMove({ circleId, cardId: CARD, kind: "pass" })).rejects.toThrow(
      /finished/,
    );
  });

  it("seats the practice partner in a solo circle and it plays its rounds", async () => {
    await putCard();
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    // Turning participation on ALSO seats the labeled practice partner in a
    // solo circle — no summoning act exists.
    const partnerPubkey = pubkeyId(partnerKey);
    const seat = { partnerPubkey };
    expect(service.sandboxState(circleId).practicePubkey).toBe(partnerPubkey);
    const roster = service.store.getMembers(circleId);
    expect(roster.find((m) => m.memberPubkey === seat.partnerPubkey)?.displayName).toBe(
      PRACTICE_PARTNER_NAME,
    );

    let session = service.sandboxState(circleId).sessions[0]!;
    expect(session.speakers).toContain(seat.partnerPubkey);

    // Drive turns until the partner has moved in round 0 (order may put us
    // first — post our move by hand, then sweep the partner).
    if (!session.moves.some((m) => m.authorPubkey === seat.partnerPubkey)) {
      if (session.myTurn) {
        await service.postSandboxMove({
          circleId,
          cardId: CARD,
          kind: "constraint",
          text: "Free June 19-26.",
        });
      }
      await practiceSandboxSweep(db, { partnerKey, now: NOW });
    }
    session = service.sandboxState(circleId).sessions[0]!;
    const partnerMove = session.moves.find((m) => m.authorPubkey === seat.partnerPubkey);
    expect(partnerMove).toBeDefined();
    expect(partnerMove!.agentAuthored).toBe(true);
    expect(partnerMove!.kind).toBe("constraint");
    expect(partnerMove!.text).toContain("Practice partner");
  });

  it("does not seat the practice partner when real members are present", async () => {
    await putCard();
    new CirclesStore(db).addMember({
      circleId,
      memberPubkey: pubkeyId(generateKeyPair()),
      scopes: DEFAULT_MEMBER_SCOPES,
    });
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    expect(service.sandboxState(circleId).practicePubkey).toBeNull();
  });

  it("R35: the chat draft prompt carries the folded canvas state", async () => {
    await putCard();
    await service.postSandboxMove({
      circleId,
      cardId: CARD,
      kind: "option.add",
      optionId: "cabin-b",
      label: "Cabin B — $185/n",
    });
    const prompt = buildQuarantinedDraftPrompt(db, {
      circleId,
      selfPubkey: service.pubkey,
      selfRequested: true,
    });
    expect(prompt).toContain("Shared canvas");
    expect(prompt).toContain("Spring trip: June, 4 people");
    expect(prompt).toContain("Cabin B");
    // The summary rides INSIDE the untrusted envelope, after its opening.
    const start = prompt.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(start).toBeGreaterThan(-1);
    expect(prompt.indexOf("Shared canvas")).toBeGreaterThan(start);
  });
});

describe("the five UX fixes (steer, refill, proposal kinds)", () => {
  let db: DatabaseSync;
  let key: KeyPair;
  let partnerKey: KeyPair;
  let service: CirclesService;
  let circleId: string;

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    key = generateKeyPair();
    partnerKey = generateKeyPair();
    service = new CirclesService({
      db,
      config: makeConfig(),
      keyPair: key,
      practiceKeys: partnerKey,
      fetchImpl: stubFetch(),
      topicBus: null,
    });
    circleId = service.createCircle({ name: "Solo", kind: "connection" });
  });

  it("steering updates guidance only — budgets, counters, and pause untouched", async () => {
    await service.setCanvasParticipation({ circleId, mode: "propose", turnBudget: 5 });
    claimSandboxTurn(db, { circleId });
    service.pauseSandbox({ circleId, reason: "resting" });
    service.steerSandbox({ circleId, guidance: "prefer cabins under $200" });
    const part = getSandboxParticipation(db, circleId)!;
    expect(part.guidance).toBe("prefer cabins under $200");
    expect(part.turnsUsed).toBe(1); // not a refill
    expect(part.pausedAt).not.toBeNull(); // not a resume
    // Steering with no participation row creates one — still propose-gated.
    const c2 = service.createCircle({ name: "Fresh", kind: "connection" });
    service.steerSandbox({ circleId: c2, guidance: "hello" });
    expect(getSandboxParticipation(db, c2)?.mode).toBe("propose");
  });

  it("re-affirming participation IS the refill and clears a budget pause", async () => {
    await service.setCanvasParticipation({ circleId, mode: "propose", turnBudget: 1 });
    expect(claimSandboxTurn(db, { circleId })).toBe(true);
    expect(claimSandboxTurn(db, { circleId })).toBe(false); // spent
    await service.setCanvasParticipation({ circleId, mode: "propose", turnBudget: 1 });
    const part = getSandboxParticipation(db, circleId)!;
    expect(part.turnsUsed).toBe(0);
    expect(claimSandboxTurn(db, { circleId })).toBe(true);
  });

  it("the sweep names the budget when it pauses (grinding is never silent)", async () => {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "t",
      text: "",
    });
    await service.setCanvasParticipation({ circleId, mode: "propose", turnBudget: 1 });
    // Spend the last turn, as real work would; the NEXT sweep names it.
    expect(claimSandboxTurn(db, { circleId })).toBe(true);
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    const part = getSandboxParticipation(db, circleId)!;
    expect(part.pausedAt).not.toBeNull();
    expect(part.pauseReason).toMatch(/turn budget/);
  });

  it("picks the proposal kind from the fold: constraint → option synthesis → vote", () => {
    const base = {
      cardId: CARD,
      taskType: "negotiation" as const,
      goal: "g",
      roundCap: 3,
      framedBy: "x",
      frameUpdatedAt: 0,
      enrollments: [],
      speakers: ["A", "B"],
      options: [],
      votes: {},
      plans: [],
      evidence: [],
      closed: null,
      currentRound: 1,
      status: "live" as const,
      lapsed: [],
      passesAt: null,
      noProgressAuthors: [],
      agreedOptionId: null,
    };
    const move = (authorPubkey: string, kind: "constraint" | "option.add" | "vote") => ({
      round: 0,
      kind,
      text: "t",
      optionId: kind === "constraint" ? "" : "opt-x",
      label: "",
      authorPubkey,
      agentAuthored: false,
      derivedFrom: [],
      authors: [authorPubkey],
      eventHash: `h-${authorPubkey}-${kind}`,
      seq: 0,
      claimedAt: 0,
    });
    // Nothing on the table: bring context.
    expect(decideProposalKind({ ...base, moves: [] }, "A")).toBe("constraint");
    // Two authors' constraints, no options: synthesize the option set (§2).
    expect(
      decideProposalKind(
        { ...base, moves: [move("A", "constraint"), move("B", "constraint")] },
        "A",
      ),
    ).toBe("option");
    // Options exist and we have not voted: settle.
    const withOption = {
      ...base,
      moves: [move("B", "option.add")],
      options: [{ optionId: "opt-x", label: "X", text: "", proposedBy: "B", round: 0 }],
    };
    expect(decideProposalKind(withOption, "A")).toBe("vote");
    // Already voted: back to contributing.
    expect(decideProposalKind({ ...withOption, votes: { "opt-x": ["A"] } }, "A")).toBe(
      "constraint",
    );
  });

  it("an approved vote proposal maps byte-identically onto a real option (M5)", async () => {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "Where?",
      text: "Cabin B\nLakehouse",
    });
    await service.setCanvasParticipation({ circleId, mode: "propose" });
    // Queue a VOTE proposal directly and generate it with a stub LLM that
    // picks an option verbatim.
    queueSandboxMoveDraft(db, { circleId, cardId: CARD, proposal: "vote" });
    await generateQueuedAgentDrafts(db, async () => "Cabin B", { selfPubkey: service.pubkey });
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND)!;
    expect(draft.targetSlot).toBe("sandbox:vote");
    await service.publishAgentDraft({ draftId: draft.draftId });
    const session = service.sandboxState(circleId).sessions[0]!;
    const mine = session.moves.find((m) => m.authorPubkey === service.pubkey)!;
    expect(mine.kind).toBe("vote");
    expect(session.votes["opt-cabin-b"]).toContain(service.pubkey);
  });

  it("a decision card's own lines are options in the fold (one vote surface)", async () => {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "Where?",
      text: "Cabin B\nLakehouse",
    });
    const session = service.sandboxState(circleId).sessions[0]!;
    expect(session.options.map((o) => o.label).toSorted()).toEqual(["Cabin B", "Lakehouse"]);
    // Voting by hand on a card-line option is legal all the way down.
    await service.postSandboxMove({
      circleId,
      cardId: CARD,
      kind: "vote",
      optionId: "opt-cabin-b",
    });
    expect(service.sandboxState(circleId).sessions[0]!.votes["opt-cabin-b"]).toContain(
      service.pubkey,
    );
  });

  it("legacy slice votes still count until that member votes through a move", async () => {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "Where?",
      text: "Cabin B\nLakehouse",
    });
    await service.putCanvasSlice({
      circleId,
      cardId: CARD,
      slot: "vote",
      value: "Lakehouse",
      note: "",
    });
    let session = service.sandboxState(circleId).sessions[0]!;
    expect(session.votes["opt-lakehouse"]).toContain(service.pubkey);
    // A real move supersedes the legacy slice.
    await service.postSandboxMove({
      circleId,
      cardId: CARD,
      kind: "vote",
      optionId: "opt-cabin-b",
    });
    session = service.sandboxState(circleId).sessions[0]!;
    expect(session.votes["opt-cabin-b"]).toContain(service.pubkey);
    expect(session.votes["opt-lakehouse"] ?? []).not.toContain(service.pubkey);
  });
});
