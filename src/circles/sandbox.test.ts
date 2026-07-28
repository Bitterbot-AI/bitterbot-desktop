import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../commerce/sku.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { makeCircleEnvelope } from "./envelope.js";
import {
  claimSandboxTurn,
  computeSandboxSessions,
  evidenceHost,
  getSandboxEnrollment,
  isMyTurn,
  normalizeSandboxInput,
  pauseSandboxEnrollment,
  recordSandboxTokenSpend,
  SANDBOX_DEFAULT_ROUND_CAP,
  speakerOrderFor,
  upsertSandboxEnrollment,
  type SandboxEventInput,
  type SandboxSession,
} from "./sandbox.js";
import { buildChainedEventBody, type ChainedEventBody } from "./tab.js";

// PLAN-38 P1(a): the canvas sandbox, headless. Under test: the sender-side
// grammar (closed enums, caps, T11 host-only sources), the deterministic
// fold (one honored move per (card, author, round), LWW on content-derived
// hashes, fold-side re-caps against raw hostile bodies), speaker-order
// determinism across two nodes, the my-turn walk, M5 vote validation, and
// the node-local enrollment ledger's guarded spend claims (R5/R10).

const NOW = 1_800_000_000_000;
const NOW_S = Math.floor(NOW / 1000);
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

describe("normalizeSandboxInput (the sender-side grammar)", () => {
  const base = { cardId: CARD, updatedAt: NOW };

  it("rejects values outside the closed enums", () => {
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.frame.put",
        ...base,
        taskType: "spectacle" as never,
        goal: "g",
      }),
    ).toThrow(/taskType/);
    expect(() =>
      normalizeSandboxInput({ type: "sandbox.enroll.put", ...base, mode: "loud" as never }),
    ).toThrow(/mode/);
    expect(() =>
      normalizeSandboxInput({ type: "sandbox.close", ...base, reason: "vibes" as never }),
    ).toThrow(/reason/);
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.move",
        cardId: CARD,
        round: 0,
        kind: "monologue" as never,
        agentAuthored: false,
      }),
    ).toThrow(/kind/);
  });

  it("refuses auto mode until P2 ships its machinery (R19)", () => {
    expect(() =>
      normalizeSandboxInput({ type: "sandbox.enroll.put", ...base, mode: "auto" }),
    ).toThrow(/P2/);
  });

  it("bounds rounds by the hard ceiling", () => {
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.move",
        cardId: CARD,
        round: 20,
        kind: "pass",
        agentAuthored: false,
      }),
    ).toThrow(/round/);
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.frame.put",
        ...base,
        taskType: "negotiation",
        goal: "g",
        roundCap: 21,
      }),
    ).toThrow(/roundCap/);
  });

  it("requires per-kind payload: option ids, labels, constraint text", () => {
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.move",
        cardId: CARD,
        round: 0,
        kind: "vote",
        optionId: "not a slug!",
        agentAuthored: false,
      }),
    ).toThrow(/optionId/);
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.move",
        cardId: CARD,
        round: 0,
        kind: "option.add",
        optionId: "cabin-b",
        agentAuthored: false,
      }),
    ).toThrow(/label/);
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.move",
        cardId: CARD,
        round: 0,
        kind: "constraint",
        text: "  ",
        agentAuthored: false,
      }),
    ).toThrow(/text/);
  });

  it("requires a reason on blocked plan steps (§3.2.4)", () => {
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.plan.put",
        ...base,
        round: 0,
        steps: [{ id: "s1", label: "search fares", state: "blocked" }],
      }),
    ).toThrow(/reason/);
  });

  it("refuses evidence sources that are not bare hostnames (T11)", () => {
    expect(() =>
      normalizeSandboxInput({
        type: "sandbox.evidence.put",
        ...base,
        round: 0,
        sources: [{ host: "kayak.com/flights?max=900" }],
      }),
    ).toThrow(/hostname/);
    expect(evidenceHost("https://Kayak.com/flights?max=900")).toBe("kayak.com");
    expect(() => evidenceHost("not a host")).toThrow(/hostname/);
  });
});

describe("the sandbox fold (real handlers, two members)", () => {
  let db: DatabaseSync;
  let store: CirclesStore;
  let circleId: string;
  let ana: KeyPair;
  let bob: KeyPair;
  let A: string;
  let B: string;

  type Envelope = Record<string, JsonValue>;

  function append(key: KeyPair, input: SandboxEventInput): Envelope {
    const body = buildChainedEventBody(db, {
      circleId,
      authorPubkey: pubkeyId(key),
      input,
      now: NOW,
    });
    const envelope = makeCircleEnvelope(
      "event",
      circleId,
      body as unknown as Record<string, JsonValue>,
      key,
      NOW_S,
    );
    const res = handleCircleMethod("circle/event.append", { envelope }, db, NOW);
    if (!res.ok) throw new Error(`append failed: ${JSON.stringify(res.error)}`);
    return envelope as unknown as Envelope;
  }

  /** A RAW chained append (bypassing normalizeSandboxInput) — what a hostile
   *  peer's node would sign. The handler validates chain + scan, not shape. */
  function appendRaw(key: KeyPair, eventType: string, event: Record<string, JsonValue>): Envelope {
    const author = pubkeyId(key);
    const head = db
      .prepare(
        `SELECT seq, event_hash FROM circle_events
          WHERE circle_id = ? AND author_pubkey = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(circleId, author) as { seq: number; event_hash: string } | undefined;
    const body: ChainedEventBody = {
      seq: head ? head.seq + 1 : 0,
      prev_hash: head ? head.event_hash : null,
      event_type: eventType,
      event,
      claimed_at: NOW,
      heads: {},
    };
    const envelope = makeCircleEnvelope(
      "event",
      circleId,
      body as unknown as Record<string, JsonValue>,
      key,
      NOW_S,
    );
    const res = handleCircleMethod("circle/event.append", { envelope }, db, NOW);
    if (!res.ok) throw new Error(`raw append failed: ${JSON.stringify(res.error)}`);
    return envelope as unknown as Envelope;
  }

  function session(d: DatabaseSync = db): SandboxSession {
    const sessions = computeSandboxSessions(d, circleId);
    expect(sessions).toHaveLength(1);
    return sessions[0]!;
  }

  function frameAndEnrollBoth(): void {
    append(ana, {
      type: "sandbox.frame.put",
      cardId: CARD,
      taskType: "negotiation",
      goal: "Spring trip: June, 4 people",
      updatedAt: NOW,
    });
    append(ana, { type: "sandbox.enroll.put", cardId: CARD, mode: "propose", updatedAt: NOW });
    append(bob, { type: "sandbox.enroll.put", cardId: CARD, mode: "propose", updatedAt: NOW });
  }

  /** Replay a list of captured envelopes into a mirrored second node. */
  function mirrorNode(envelopes: Envelope[]): DatabaseSync {
    const db2 = openDb();
    new CirclesStore(db2).importCircle(
      {
        circleId,
        name: "Roomies",
        kind: "expense",
        creatorPubkey: A,
        keyEpoch: 0,
        createdAt: NOW,
      },
      [
        { memberPubkey: A, role: "creator", scopes: DEFAULT_MEMBER_SCOPES },
        { memberPubkey: B, role: "member", scopes: DEFAULT_MEMBER_SCOPES },
      ],
      NOW,
    );
    for (const envelope of envelopes) {
      const res = handleCircleMethod("circle/event.append", { envelope }, db2, NOW);
      if (!res.ok) throw new Error(`mirror append failed: ${JSON.stringify(res.error)}`);
    }
    return db2;
  }

  beforeEach(() => {
    resetCircleRateLimits();
    db = openDb();
    store = new CirclesStore(db);
    ana = generateKeyPair();
    bob = generateKeyPair();
    A = pubkeyId(ana);
    B = pubkeyId(bob);
    circleId = store.createCircle({
      name: "Roomies",
      kind: "expense",
      creatorPubkey: A,
      now: NOW,
    });
    store.addMember({
      circleId,
      memberPubkey: B,
      scopes: DEFAULT_MEMBER_SCOPES,
      now: NOW,
    });
  });

  it("folds frame + enrollments into a gathering session", () => {
    frameAndEnrollBoth();
    const s = session();
    expect(s.cardId).toBe(CARD);
    expect(s.taskType).toBe("negotiation");
    expect(s.goal).toBe("Spring trip: June, 4 people");
    expect(s.roundCap).toBe(SANDBOX_DEFAULT_ROUND_CAP);
    expect(s.framedBy).toBe(A);
    expect(s.speakers).toEqual([A, B].toSorted());
    expect(s.status).toBe("gathering");
    expect(s.currentRound).toBe(0);
  });

  it("honors concurrent moves (one per author per round) and drops an author's duplicate", () => {
    frameAndEnrollBoth();
    append(ana, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "constraint",
      text: "Sam's calendar blocks June 12-14",
      agentAuthored: true,
    });
    append(bob, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "constraint",
      text: "ceiling is $900, no red-eyes",
      agentAuthored: true,
    });
    // Ana tries a second round-0 move: stored on her chain, never honored.
    append(ana, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "constraint",
      text: "actually, one more thing",
      agentAuthored: true,
    });
    const s = session();
    expect(s.moves).toHaveLength(2);
    expect(s.moves.map((m) => m.authorPubkey).toSorted()).toEqual([A, B].toSorted());
    expect(s.moves.find((m) => m.authorPubkey === A)?.text).toBe(
      "Sam's calendar blocks June 12-14",
    );
    expect(s.moves.every((m) => m.agentAuthored)).toBe(true);
    // Both spoke: round 0 is complete, the session is live in round 1.
    expect(s.status).toBe("live");
    expect(s.currentRound).toBe(1);
  });

  it("folds a mailbox-lagged late move into its original round, identically on both nodes", () => {
    const envelopes: Envelope[] = [];
    envelopes.push(
      append(ana, {
        type: "sandbox.frame.put",
        cardId: CARD,
        taskType: "negotiation",
        goal: "goal",
        updatedAt: NOW,
      }),
      append(ana, { type: "sandbox.enroll.put", cardId: CARD, mode: "propose", updatedAt: NOW }),
      append(bob, { type: "sandbox.enroll.put", cardId: CARD, mode: "propose", updatedAt: NOW }),
      append(ana, {
        type: "sandbox.move",
        cardId: CARD,
        round: 0,
        kind: "constraint",
        text: "ana round 0",
        agentAuthored: false,
      }),
    );
    // Bob's round-0 move exists but has not arrived yet; Ana already posted
    // her round-1 move (timeouts only ever PERMIT later speakers).
    const bobLate = append(bob, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "constraint",
      text: "bob round 0, delayed in the mailbox",
      agentAuthored: false,
    });
    envelopes.push(
      append(ana, {
        type: "sandbox.move",
        cardId: CARD,
        round: 1,
        kind: "constraint",
        text: "ana round 1",
        agentAuthored: false,
      }),
    );
    // Node B receives Bob's round-0 move LAST, after Ana's round-1 move.
    const db2 = mirrorNode([...envelopes, bobLate]);

    for (const d of [db, db2]) {
      const s = session(d);
      const round0 = s.moves.filter((m) => m.round === 0);
      expect(round0.map((m) => m.authorPubkey).toSorted()).toEqual([A, B].toSorted());
      // Bob has not moved in round 1 yet, so the session sits in round 1.
      expect(s.currentRound).toBe(1);
    }
    // The two nodes fold the identical session despite different arrival order.
    expect(session(db2)).toEqual(session(db));
  });

  it("re-caps and re-validates raw hostile bodies fold-side (sender caps are never trusted)", () => {
    frameAndEnrollBoth();
    // A hostile node signs raw bodies: oversized goal, a 5KB move, a bogus
    // move kind, an out-of-range round, an evidence "host" carrying a query
    // string, and a 40-step plan.
    appendRaw(bob, "sandbox.frame.put", {
      card_id: CARD,
      task_type: "negotiation",
      goal: "x".repeat(10_000),
      round_cap: 3,
      updated_at: NOW + 1, // wins LWW over Ana's frame
    });
    appendRaw(bob, "sandbox.move", {
      card_id: CARD,
      round: 1,
      kind: "constraint",
      text: "y".repeat(5_000),
      option_id: "",
      label: "",
      derived_from: [],
      agent_authored: "yes" as unknown as JsonValue, // not a boolean
    });
    appendRaw(bob, "sandbox.move", { card_id: CARD, round: 0, kind: "monologue", text: "zz" });
    appendRaw(bob, "sandbox.move", { card_id: CARD, round: 99, kind: "pass" });
    appendRaw(bob, "sandbox.evidence.put", {
      card_id: CARD,
      round: 0,
      sources: [
        { host: "kayak.com/flights?max=900", title: "leak" },
        { host: "kayak.com", title: "t".repeat(500), content_hash: "nothex" },
      ] as unknown as JsonValue,
      updated_at: NOW,
    });
    appendRaw(bob, "sandbox.plan.put", {
      card_id: CARD,
      round: 0,
      steps: Array.from({ length: 40 }, (_, i) => ({
        id: `s${i}`,
        label: "l".repeat(400),
        state: i === 0 ? "cruising" : "pending", // unknown state
        reason: "",
      })) as unknown as JsonValue,
      updated_at: NOW,
    });

    const s = session();
    expect(s.goal).toHaveLength(1000);
    // Only the oversized round-1 constraint survives, capped; the bogus kind
    // and the round-99 move are dropped.
    expect(s.moves).toHaveLength(1);
    expect(s.moves[0]!.round).toBe(1);
    expect(s.moves[0]!.text).toHaveLength(500);
    expect(s.moves[0]!.agentAuthored).toBe(false); // non-boolean never truthy
    // The path-carrying source is dropped; the valid host survives with a
    // capped title and the malformed hash blanked.
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]!.sources).toEqual([
      { host: "kayak.com", title: "t".repeat(120), contentHash: "" },
    ]);
    // The plan is truncated to 12 steps and unknown states fail to 'pending'.
    expect(s.plans).toHaveLength(1);
    expect(s.plans[0]!.steps).toHaveLength(12);
    expect(s.plans[0]!.steps[0]!.state).toBe("pending");
    expect(s.plans[0]!.steps[0]!.label).toHaveLength(120);
  });

  it("never creates a session from a frame with an unknown task type (fail closed)", () => {
    appendRaw(ana, "sandbox.frame.put", {
      card_id: CARD,
      task_type: "spectacle",
      goal: "watch us",
      round_cap: 3,
      updated_at: NOW,
    });
    expect(computeSandboxSessions(db, circleId)).toHaveLength(0);
  });

  it("computes identical speaker order on both nodes, and rotates it across rounds", () => {
    frameAndEnrollBoth();
    const envelopes: Envelope[] = [];
    // Rebuild node B from scratch in reversed author order.
    const rows = db
      .prepare(
        `SELECT envelope_json FROM circle_events WHERE circle_id = ?
          ORDER BY author_pubkey DESC, seq ASC`,
      )
      .all(circleId) as unknown as Array<{ envelope_json: string }>;
    for (const r of rows) envelopes.push(JSON.parse(r.envelope_json) as Envelope);
    const db2 = mirrorNode(envelopes);

    const s1 = session(db);
    const s2 = session(db2);
    expect(s2).toEqual(s1);
    for (let r = 0; r < 64; r++) {
      expect(speakerOrderFor(CARD, r, s2.speakers)).toEqual(speakerOrderFor(CARD, r, s1.speakers));
    }
    // Rotation: with 2 members over 64 rounds, both orderings occur (the
    // digest sort is a per-round coin flip; all-identical has p = 2^-63).
    const firsts = new Set(
      Array.from({ length: 64 }, (_, r) => speakerOrderFor(CARD, r, s1.speakers)[0]),
    );
    expect(firsts.size).toBe(2);
  });

  it("walks turns in speaker order (the my-turn test)", () => {
    frameAndEnrollBoth();
    let s = session();
    const order = speakerOrderFor(CARD, 0, s.speakers);
    const [firstKey, secondKey] = order[0] === A ? [ana, bob] : [bob, ana];

    expect(isMyTurn(s, order[0]!)).toBe(true);
    expect(isMyTurn(s, order[1]!)).toBe(false);
    expect(isMyTurn(s, "pk-stranger")).toBe(false);

    append(firstKey, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "pass",
      agentAuthored: false,
    });
    s = session();
    expect(isMyTurn(s, order[0]!)).toBe(false); // already moved
    expect(isMyTurn(s, order[1]!)).toBe(true);

    append(secondKey, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "pass",
      agentAuthored: false,
    });
    s = session();
    expect(s.currentRound).toBe(1);
    // Round 1 re-derives its own order; exactly one of them is up.
    const order1 = speakerOrderFor(CARD, 1, s.speakers);
    expect(isMyTurn(s, order1[0]!)).toBe(true);
    expect(isMyTurn(s, order1[1]!)).toBe(false);
  });

  it("tallies votes only against options that exist (M5) and keeps each author's latest", () => {
    frameAndEnrollBoth();
    append(ana, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "option.add",
      optionId: "cabin-b",
      label: "Cabin B — $185/n",
      agentAuthored: true,
    });
    append(bob, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "vote",
      optionId: "phantom",
      agentAuthored: false,
    });
    append(bob, {
      type: "sandbox.move",
      cardId: CARD,
      round: 1,
      kind: "vote",
      optionId: "cabin-b",
      agentAuthored: false,
    });
    const s = session();
    expect(s.options).toHaveLength(1);
    expect(s.options[0]).toMatchObject({ optionId: "cabin-b", proposedBy: A, round: 0 });
    // The phantom vote is on Bob's chain but never tallied; his round-1 vote
    // for the real option is his standing vote.
    expect(s.votes).toEqual({ "cabin-b": [B] });
  });

  it("recomputes transitive author provenance receiver-side (M1)", () => {
    frameAndEnrollBoth();
    append(ana, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "option.add",
      optionId: "cabin-b",
      label: "Cabin B",
      agentAuthored: true,
    });
    const anaMove = session().moves[0]!;
    append(bob, {
      type: "sandbox.move",
      cardId: CARD,
      round: 0,
      kind: "vote",
      optionId: "cabin-b",
      derivedFrom: [anaMove.eventHash],
      agentAuthored: false,
    });
    const s = session();
    const bobMove = s.moves.find((m) => m.authorPubkey === B)!;
    expect(bobMove.authors).toEqual([A, B].toSorted());
    // A reference to an unknown hash contributes nothing (never trusted).
    expect(s.moves.find((m) => m.authorPubkey === A)!.authors).toEqual([A]);
  });

  it("closes terminally with an attributed, legible reason", () => {
    frameAndEnrollBoth();
    append(bob, { type: "sandbox.close", cardId: CARD, reason: "human", updatedAt: NOW });
    const s = session();
    expect(s.status).toBe("closed");
    expect(s.closed).toEqual({ reason: "human", byPubkey: B, at: NOW });
    expect(isMyTurn(s, A)).toBe(false);
    expect(isMyTurn(s, B)).toBe(false);
    // A raw garbage reason still closes, attributed as a human call.
    appendRaw(ana, "sandbox.close", { card_id: CARD, reason: "vibes", updated_at: NOW - 10 });
    expect(session().closed).toMatchObject({ reason: "human", byPubkey: A });
  });
});

describe("circle_sandbox_enrollments (the private half — gates all spend)", () => {
  let db: DatabaseSync;
  const circleId = "c1";

  beforeEach(() => {
    db = openDb();
  });

  it("claims turns atomically until the turn budget is spent", () => {
    upsertSandboxEnrollment(db, {
      circleId,
      cardId: CARD,
      mode: "propose",
      turnBudget: 2,
      now: NOW,
    });
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(true);
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(true);
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(false);
    expect(getSandboxEnrollment(db, circleId, CARD)?.turnsUsed).toBe(2);
  });

  it("refuses claims when off, paused, expired, or out of token budget", () => {
    upsertSandboxEnrollment(db, { circleId, cardId: CARD, mode: "off", now: NOW });
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(false);

    upsertSandboxEnrollment(db, { circleId, cardId: CARD, mode: "propose", now: NOW });
    pauseSandboxEnrollment(db, { circleId, cardId: CARD, reason: "no progress", now: NOW });
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(false);
    expect(getSandboxEnrollment(db, circleId, CARD)?.pauseReason).toBe("no progress");

    // Re-enrolling is the human resuming: the pause clears.
    upsertSandboxEnrollment(db, {
      circleId,
      cardId: CARD,
      mode: "propose",
      tokenBudget: 100,
      expiresAt: NOW + 1000,
      now: NOW,
    });
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(true);
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW + 2000 })).toBe(false); // expired
    recordSandboxTokenSpend(db, { circleId, cardId: CARD, tokens: 100, now: NOW });
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(false); // tokens gone
  });

  it("refuses to represent auto mode until P2 (R19) and missing enrollments never claim", () => {
    expect(() =>
      upsertSandboxEnrollment(db, { circleId, cardId: CARD, mode: "auto" as never, now: NOW }),
    ).toThrow(/mode/);
    expect(claimSandboxTurn(db, { circleId, cardId: CARD, now: NOW })).toBe(false);
    expect(getSandboxEnrollment(db, circleId, CARD)).toBeNull();
  });
});
