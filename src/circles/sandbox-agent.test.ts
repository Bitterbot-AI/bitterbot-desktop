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
  practiceSandboxSweep,
  SANDBOX_DRAFT_KIND,
  sweepSandboxTurns,
  validateSandboxMoveText,
} from "./sandbox-agent.js";
import { getSandboxEnrollment } from "./sandbox.js";
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

  async function frameCard(): Promise<void> {
    await service.putCanvasCard({
      circleId,
      cardId: CARD,
      cardType: "decision",
      title: "Spring trip: June, 4 people",
      text: "",
    });
    await service.frameSandboxSession({ circleId, cardId: CARD });
  }

  it("frames a session on an existing card only, goal defaulting to the title", async () => {
    await expect(service.frameSandboxSession({ circleId, cardId: "ghost" })).rejects.toThrow(
      /not on the canvas/,
    );
    await frameCard();
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
    await frameCard();
    // Framing alone must never spend: enrollment is a separate human act, and
    // it is what makes default-on safe.
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(0);
    expect(service.agentDrafts(circleId)).toHaveLength(0);
  });

  it("sweeps a turn: claims spend atomically, queues one proposal, never duplicates", async () => {
    await frameCard();
    await service.enrollSandbox({
      circleId,
      cardId: CARD,
      mode: "propose",
      turnBudget: 3,
      guidance: "Free June 19-26; prefer driving distance; cap $200/night.",
    });
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(1);
    expect(getSandboxEnrollment(db, circleId, CARD)?.turnsUsed).toBe(1);
    // Live proposal exists: no re-queue, no second spend.
    expect(sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW }).queued).toBe(0);
    expect(getSandboxEnrollment(db, circleId, CARD)?.turnsUsed).toBe(1);
  });

  it("generates via the quarantined prompt and publishes behind the tap (R5 both gates)", async () => {
    await frameCard();
    await service.enrollSandbox({
      circleId,
      cardId: CARD,
      mode: "propose",
      guidance: "Free June 19-26.",
    });
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
    expect(session.moves).toHaveLength(1);
    expect(session.moves[0]).toMatchObject({
      kind: "constraint",
      round: 0,
      agentAuthored: true,
      authorPubkey: service.pubkey,
    });
  });

  it("refuses the publish tap when the enrollment was paused since the claim", async () => {
    await frameCard();
    await service.enrollSandbox({ circleId, cardId: CARD, mode: "propose" });
    sweepSandboxTurns(db, { selfPubkey: service.pubkey, now: NOW });
    await generateQueuedAgentDrafts(db, async () => "A perfectly fine move.", {
      selfPubkey: service.pubkey,
    });
    const draft = service.agentDrafts(circleId).find((d) => d.kind === SANDBOX_DRAFT_KIND)!;
    service.pauseSandbox({ circleId, cardId: CARD, reason: "thinking it over" });
    await expect(service.publishAgentDraft({ draftId: draft.draftId })).rejects.toThrow(/paused/);
    // Nothing reached the ledger; the draft went back to ready for later.
    expect(service.sandboxState(circleId).sessions[0]!.moves).toHaveLength(0);
    expect(service.agentDrafts(circleId).some((d) => d.draftId === draft.draftId)).toBe(true);
    service.resumeSandbox({ circleId, cardId: CARD });
    await service.publishAgentDraft({ draftId: draft.draftId });
    expect(service.sandboxState(circleId).sessions[0]!.moves).toHaveLength(1);
  });

  it("keeps display names out of the sandbox prompt (R3 opaque ids)", async () => {
    await frameCard();
    // A second member with a distinctive display name, enrolled via raw event.
    const other = generateKeyPair();
    new CirclesStore(db).addMember({
      circleId,
      memberPubkey: pubkeyId(other),
      displayName: "AnaVeryVisibleName",
      scopes: DEFAULT_MEMBER_SCOPES,
    });
    await service.enrollSandbox({ circleId, cardId: CARD, mode: "propose" });
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
    await frameCard();
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
      /closed/,
    );
  });

  it("seats the practice partner in a solo circle and it plays its rounds", async () => {
    await frameCard();
    await service.enrollSandbox({ circleId, cardId: CARD, mode: "propose" });
    const seat = await service.addSandboxPracticeSeat({ circleId, cardId: CARD });
    expect(seat.partnerPubkey).toBe(pubkeyId(partnerKey));
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

  it("refuses the practice seat when real members are present", async () => {
    await frameCard();
    new CirclesStore(db).addMember({
      circleId,
      memberPubkey: pubkeyId(generateKeyPair()),
      scopes: DEFAULT_MEMBER_SCOPES,
    });
    await expect(service.addSandboxPracticeSeat({ circleId, cardId: CARD })).rejects.toThrow(
      /solo circles/,
    );
  });

  it("R35: the chat draft prompt carries the folded canvas state", async () => {
    await frameCard();
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
