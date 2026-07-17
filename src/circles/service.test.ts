import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import {
  blobDigest,
  buildMailboxProof,
  handleMailboxMethod,
  resetMailboxRateLimits,
} from "../gateway/a2a/mailbox.js";
import { DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { generateBoxKeyPair, sealToBox } from "./box-crypto.js";
import { setDisclosureGrant } from "./disclosure.js";
import { makeCircleEnvelope } from "./envelope.js";
import { createInvite, parseInviteCode } from "./invites.js";
import { pendingJoinBackoffMs } from "./pending-join.js";
import { CirclesService, type FetchLike } from "./service.js";

// PLAN-31 C1 end-to-end: two nodes (two DBs, two keys), a fake fetch that
// routes each dial to the OTHER node's real A2A handlers. Exercises the full
// ceremony: invite -> join -> roster mirror -> message -> presence ->
// reciprocity, with no HTTP server involved.

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

/**
 * Routes https://<host>.test/a2a to that host's DB via the real handlers.
 * mailbox/* verbs are served even when a host is marked offline — the
 * asymmetric-window case: the relay stays up while the friend's laptop is
 * closed, so circle/* dials fail but deposited mail persists.
 */
function meshFetch(
  nodes: Record<string, DatabaseSync>,
  opts: { offline?: Set<string> } = {},
): FetchLike {
  return async (url, init) => {
    const host = /https:\/\/([a-z]+)\.test\//.exec(url)?.[1];
    const db = host ? nodes[host] : undefined;
    if (!db) {
      return { ok: false, status: 502, text: async () => "no such node" };
    }
    const rpc = JSON.parse(init?.body ?? "{}") as {
      id: string;
      method: string;
      params: unknown;
    };
    const isMailbox = rpc.method.startsWith("mailbox/");
    if (!isMailbox && opts.offline?.has(host as string)) {
      return { ok: false, status: 502, text: async () => "node offline" };
    }
    const outcome = isMailbox
      ? handleMailboxMethod(rpc.method, rpc.params, db, Date.now())
      : handleCircleMethod(rpc.method, rpc.params, db, Date.now());
    const body = outcome.ok
      ? { jsonrpc: "2.0", result: outcome.result, id: rpc.id }
      : { jsonrpc: "2.0", error: outcome.error, id: rpc.id };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function makeConfig(name: string, host: string, mailboxHost?: string): BitterbotConfig {
  return {
    circles: {
      enabled: true,
      a2aPublicUrl: `https://${host}.test`,
      displayName: name,
      ...(mailboxHost ? { mailbox: { url: `https://${mailboxHost}.test`, serve: false } } : {}),
    },
  };
}

describe("CirclesService end-to-end (two nodes)", () => {
  let anaDb: DatabaseSync;
  let bobDb: DatabaseSync;
  let ana: CirclesService;
  let bob: CirclesService;
  let anaKey: KeyPair;
  let bobKey: KeyPair;

  beforeEach(() => {
    resetCircleRateLimits();
    resetMailboxRateLimits();
    anaDb = openDb();
    bobDb = openDb();
    anaKey = generateKeyPair();
    bobKey = generateKeyPair();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb });
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });
  });

  it("connects two nodes: invite -> join -> mirrored rosters on both sides", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    const joined = await bob.redeemInviteCode(invite.code);
    expect(joined.circleId).toBe(invite.circleId);
    expect(joined.members).toBe(2);

    // Ana's node (the server side) has Bob as an active member.
    const anaView = ana.store.getMembers(invite.circleId).map((m) => m.memberPubkey);
    expect(anaView.toSorted()).toEqual([pubkeyId(anaKey), pubkeyId(bobKey)].toSorted());

    // Bob's node mirrored the same circle id + roster.
    const bobView = bob.store.getMembers(invite.circleId).map((m) => m.memberPubkey);
    expect(bobView.toSorted()).toEqual(anaView.toSorted());

    // Both count exactly one connection (the friend-node count).
    expect(ana.connectionCount()).toBe(1);
    expect(bob.connectionCount()).toBe(1);
  });

  it("carries a conversation both ways and computes reciprocity", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    const bobSend = await bob.sendMessage({
      circleId,
      text: "my human wants to plan Tahoe",
    });
    expect(bobSend.delivered).toEqual([pubkeyId(anaKey)]);
    expect(bobSend.failed).toEqual([]);
    // B5: the outbound row records the delivery truth.
    expect(bob.messages(circleId).find((m) => m.direction === "out")?.deliveryStatus).toBe(
      "delivered",
    );

    // Ana's inbound buffer holds Bob's message, wrapped.
    const anaInbox = ana.messages(circleId).filter((m) => m.direction === "in");
    expect(anaInbox).toHaveLength(1);
    expect(anaInbox[0]?.content).toContain("plan Tahoe");
    expect(anaInbox[0]?.content.toLowerCase()).toContain("untrusted");

    const anaSend = await ana.sendMessage({ circleId, text: "the 14th works for us" });
    expect(anaSend.delivered).toEqual([pubkeyId(bobKey)]);

    // Reciprocity: each side has one reciprocated peer this week.
    expect(ana.reciprocity()).toEqual({ reciprocatedPeers: 1, activePeers: 1 });
    expect(bob.reciprocity()).toEqual({ reciprocatedPeers: 1, activePeers: 1 });
  });

  it("threads a reply to the parent's envelope id across nodes (A3)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Ana sends; the envelope id is the reference every node shares.
    const sent = await ana.sendMessage({ circleId, text: "who's got the notes?" });
    const bobInbox = bob.messages(circleId).filter((m) => m.direction === "in");
    expect(bobInbox[0]?.envelopeId).toBe(sent.envelopeId);

    // Bob replies to it; Ana receives the reply carrying the same reference…
    await bob.sendMessage({ circleId, text: "i do!", replyTo: sent.envelopeId });
    const anaReply = ana.messages(circleId).find((m) => m.direction === "in" && m.replyTo);
    expect(anaReply?.replyTo).toBe(sent.envelopeId);
    // …and Ana holds the parent under that envelope id, so it resolves locally.
    expect(ana.messages(circleId).some((m) => m.envelopeId === sent.envelopeId)).toBe(true);
  });

  it("shares a canvas card across nodes and folds put/update/remove (C1)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const tick = () => new Promise((r) => setTimeout(r, 3)); // distinct updated_at for LWW

    // Ana adds a card; Bob (online) receives it via the event fan-out.
    await ana.putCanvasCard({
      circleId,
      cardId: "card1",
      cardType: "note",
      title: "Krebs cycle",
      text: "acetyl-CoA → …",
    });
    expect(bob.canvasCards(circleId).map((c) => c.title)).toContain("Krebs cycle");
    expect(bob.canvasCards(circleId)[0]?.authorPubkey).toBe(pubkeyId(anaKey));

    // Update the same card (LWW by updated_at) — the newer text wins on both nodes.
    await tick();
    await ana.putCanvasCard({
      circleId,
      cardId: "card1",
      cardType: "note",
      title: "Krebs cycle (v2)",
      text: "acetyl-CoA → citrate → …",
    });
    expect(bob.canvasCards(circleId).find((c) => c.cardId === "card1")?.title).toBe(
      "Krebs cycle (v2)",
    );
    expect(bob.canvasCards(circleId)).toHaveLength(1); // still one card, not two

    // Remove tombstones it everywhere.
    await tick();
    await ana.removeCanvasCard({ circleId, cardId: "card1" });
    expect(bob.canvasCards(circleId).some((c) => c.cardId === "card1")).toBe(false);
    expect(ana.canvasCards(circleId).some((c) => c.cardId === "card1")).toBe(false);
  });

  it("folds per-member votes on a Decision Card (C2)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const tick = () => new Promise((r) => setTimeout(r, 3));

    // Ana posts a decision (a card of type "decision"); both members vote (slices).
    await ana.putCanvasCard({
      circleId,
      cardId: "d1",
      cardType: "decision",
      title: "When do we review?",
      text: "Thu\nFri",
    });
    await ana.putCanvasSlice({
      circleId,
      cardId: "d1",
      slot: "vote",
      value: "Thu",
      note: "after 6",
    });
    await bob.putCanvasSlice({ circleId, cardId: "d1", slot: "vote", value: "Thu", note: "" });

    // Both nodes see the decision card with two vote slices, attributed.
    const bobCard = bob.canvasCards(circleId).find((c) => c.cardId === "d1");
    expect(bobCard?.cardType).toBe("decision");
    const votes = (bobCard?.slices ?? []).filter((s) => s.slot === "vote");
    expect(votes).toHaveLength(2);
    expect(votes.map((v) => v.value).toSorted()).toEqual(["Thu", "Thu"]);

    // A member changing their vote is LWW per author — not a second vote.
    await tick();
    await ana.putCanvasSlice({ circleId, cardId: "d1", slot: "vote", value: "Fri", note: "" });
    const after = (bob.canvasCards(circleId).find((c) => c.cardId === "d1")?.slices ?? []).filter(
      (s) => s.slot === "vote",
    );
    expect(after).toHaveLength(2); // still two voters
    expect(after.find((v) => v.authorPubkey === pubkeyId(anaKey))?.value).toBe("Fri");
  });

  it("assembles a study guide from per-member section slices (C3)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const tick = () => new Promise((r) => setTimeout(r, 3));

    // Ana posts the guide skeleton: sections ride the card text, one per line
    // (same shape as decision options). Contributions are per-section slices.
    await ana.putCanvasCard({
      circleId,
      cardId: "sg1",
      cardType: "study",
      title: "BIO-204 Midterm 2",
      text: "Glycolysis\nKrebs cycle\nElectron transport",
    });

    // Both members contribute to the SAME section — slices merge per author,
    // they don't overwrite. A contribution is paragraph-sized (>200 chars),
    // which pins the raised slice value cap.
    const anaContribution =
      "Glycolysis: glucose → 2 pyruvate in the cytosol; net 2 ATP (substrate-level) + 2 NADH. " +
      "Investment phase burns 2 ATP (hexokinase, PFK-1 = committed step); payoff phase yields 4. " +
      "PFK-1 is the key regulatory valve: ATP/citrate inhibit, AMP/F2,6BP activate.";
    expect(anaContribution.length).toBeGreaterThan(200);
    await ana.putCanvasSlice({
      circleId,
      cardId: "sg1",
      slot: "sec-glycolysis",
      value: anaContribution,
      note: "lecture 12",
    });
    await bob.putCanvasSlice({
      circleId,
      cardId: "sg1",
      slot: "sec-glycolysis",
      value: "Mnemonic: Goodness Gracious, Father Franklin...",
      note: "",
    });
    await bob.putCanvasSlice({
      circleId,
      cardId: "sg1",
      slot: "sec-krebs",
      value: "8 steps, 2 turns per glucose: 6 NADH, 2 FADH2, 2 GTP.",
      note: "",
    });

    // Every node folds the same assembled guide: 2 authors on glycolysis
    // (Ana's long contribution intact), 1 on Krebs, a gap on ETC.
    for (const node of [ana, bob]) {
      const card = node.canvasCards(circleId).find((c) => c.cardId === "sg1");
      expect(card?.cardType).toBe("study");
      const glyco = (card?.slices ?? []).filter((s) => s.slot === "sec-glycolysis");
      expect(glyco).toHaveLength(2);
      expect(glyco.find((s) => s.authorPubkey === pubkeyId(anaKey))?.value).toBe(anaContribution);
      expect((card?.slices ?? []).filter((s) => s.slot === "sec-krebs")).toHaveLength(1);
      expect((card?.slices ?? []).filter((s) => s.slot === "sec-etc")).toHaveLength(0);
    }

    // Editing your contribution is LWW per (card, slot, author) — it replaces.
    await tick();
    await bob.putCanvasSlice({
      circleId,
      cardId: "sg1",
      slot: "sec-glycolysis",
      value: "Mnemonic v2",
      note: "",
    });
    const after = (ana.canvasCards(circleId).find((c) => c.cardId === "sg1")?.slices ?? []).filter(
      (s) => s.slot === "sec-glycolysis",
    );
    expect(after).toHaveLength(2); // still two contributors
    expect(after.find((s) => s.authorPubkey === pubkeyId(bobKey))?.value).toBe("Mnemonic v2");
  });

  it("propagates presence heartbeats into the peer-presence table", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    await bob.heartbeat();
    const seen = ana.peerPresence();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.peerPubkey).toBe(pubkeyId(bobKey));
    expect(seen[0]?.lastStatus).toBe("online");
  });

  it("refuses to mint invites without a public URL and on inactive circles", () => {
    const lonely = new CirclesService({
      db: openDb(),
      config: { circles: { enabled: true } },
      fetchImpl: meshFetch({}),
      keyPair: generateKeyPair(),
    });
    expect(() => lonely.createInviteCode({})).toThrow(/a2aPublicUrl/);

    const circleId = ana.createCircle({ name: "Frozen" });
    ana.store.freezeCircle(circleId);
    expect(() => ana.createInviteCode({ circleId })).toThrow(/frozen/);
  });

  it("supports a 3-node circle: one invite each, fan-out reaches everyone", async () => {
    const carolDb = openDb();
    const carolKey = generateKeyPair();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb, carol: carolDb });
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });
    const carol = new CirclesService({
      db: carolDb,
      config: makeConfig("Carol's agent", "carol"),
      fetchImpl,
      keyPair: carolKey,
    });

    const circleId = ana.createCircle({ name: "Tahoe Crew", kind: "trip" });
    await bob.redeemInviteCode(ana.createInviteCode({ circleId }).code);
    await carol.redeemInviteCode(ana.createInviteCode({ circleId }).code);

    // Carol re-syncs the roster through her join (Bob joined first); Ana's
    // fan-out reaches both.
    const report = await ana.sendMessage({ circleId, text: "kickoff: dates poll tomorrow" });
    expect(report.delivered.toSorted()).toEqual([pubkeyId(bobKey), pubkeyId(carolKey)].toSorted());
    expect(bob.messages(circleId).some((m) => m.content.includes("kickoff"))).toBe(true);
    expect(carol.messages(circleId).some((m) => m.content.includes("kickoff"))).toBe(true);
  });

  it("delivers through the mailbox when the peer is offline (store-and-forward §3.2)", async () => {
    // relay = a third node hosting mailboxes; bob's laptop will be closed.
    const relayDb = openDb();
    const offline = new Set<string>();
    const nodes = { ana: anaDb, bob: bobDb, relay: relayDb };
    const fetchImpl = meshFetch(nodes, { offline });
    const anaBox = generateBoxKeyPair();
    const bobBox = generateBoxKeyPair();
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana", "relay"),
      fetchImpl,
      keyPair: anaKey,
      boxKeys: anaBox,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: bobBox,
    });

    // Connect while both are online (join advertises box key + mailbox URL).
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Bob's laptop closes. Ana's send falls back to the relay mailbox.
    offline.add("bob");
    const report = await ana.sendMessage({ circleId, text: "logged the pizza, $42 split 2" });
    expect(report.delivered).toEqual([pubkeyId(bobKey)]);
    expect(report.failed).toEqual([]);

    // Nothing reached Bob's node yet.
    expect(bob.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(0);
    // The relay stored ciphertext only — the plaintext appears nowhere.
    const stored = relayDb.prepare(`SELECT blob_json FROM mailbox_blobs`).all() as Array<{
      blob_json: string;
    }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blob_json).not.toContain("pizza");

    // Bob wakes and drains his mailbox: the message lands through the SAME
    // hostile-principal path (wrapped), and the relay is emptied by the ack.
    offline.delete("bob");
    const drained = await bob.pollMailbox();
    expect(drained).toEqual({ received: 1, dispatched: 1 });
    const inbox = bob.messages(circleId).filter((m) => m.direction === "in");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toContain("pizza");
    expect(inbox[0]?.content.toLowerCase()).toContain("untrusted");
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 0 });

    // A second poll is a no-op (acked), and a replayed live dial of the same
    // envelope would be deduped — delivered exactly once.
    expect(await bob.pollMailbox()).toEqual({ received: 0, dispatched: 0 });
    expect(bob.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(1);
  });

  it("reports a failed send (never a silent retry) when an offline peer has no mailbox", async () => {
    // No mailbox host on either side, so Bob advertises no mailbox URL at join.
    // When his laptop closes there is nowhere to store-and-forward — the send
    // must surface as failed, not vanish. This locks in the corrected contract
    // (an earlier docstring wrongly claimed the mailbox always queues it);
    // PLAN-36 Phase 0 renders this failed state instead of discarding it.
    const offline = new Set<string>();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb }, { offline });
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });

    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    offline.add("bob");
    const report = await ana.sendMessage({ circleId, text: "still around?" });
    expect(report.delivered).toEqual([]);
    expect(report.failed).toEqual([pubkeyId(bobKey)]);
    // B5: the outbound row is marked failed, not left looking delivered.
    expect(ana.messages(circleId).find((m) => m.direction === "out")?.deliveryStatus).toBe(
      "failed",
    );
  });

  it("also publishes sends to the circle topic and subscribes active circles (mesh transport)", async () => {
    // PLAN-36 Phase 4: with a topic bus injected, a send fans to the mesh topic
    // (additive to direct/mailbox) and the node subscribes its active circles.
    const published: Array<{ topic: string; frame: string }> = [];
    const subscribed: string[] = [];
    const topicBus = {
      async publish(topic: string, frame: string) {
        published.push({ topic, frame });
      },
      async subscribe(topic: string) {
        subscribed.push(topic);
      },
      async unsubscribe() {},
    };
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb });
    const anaBus = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
      topicBus,
    });
    const invite = anaBus.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    await anaBus.sendMessage({ circleId, text: "hi over the mesh" });
    // The message rode the topic (frame carries the signed envelope).
    expect(published.some((p) => p.frame.includes("hi over the mesh"))).toBe(true);
    expect(published.every((p) => /^bitterbot\/circle\/[0-9a-f]{64}\/v1$/.test(p.topic))).toBe(
      true,
    );

    // And the node subscribes the (non-practice) circle's topic to receive.
    await anaBus.ensureCircleSubscriptions();
    expect(subscribed).toContain(published[0]?.topic);
  });

  it("keeps the shared tab identical on both nodes (append -> fan-out -> fold)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const A = pubkeyId(anaKey);
    const B = pubkeyId(bobKey);

    const pizza = await ana.appendTabEvent({
      circleId,
      input: { type: "expense.add", memo: "pizza", amountCents: 4200, participants: [A, B] },
    });
    expect(pizza.delivered).toEqual([B]);
    const coffee = await bob.appendTabEvent({
      circleId,
      input: { type: "expense.add", memo: "coffee", amountCents: 1000, participants: [A, B] },
    });
    expect(coffee.delivered).toEqual([A]);

    // Both nodes fold the identical balances: Bob owes Ana 1600 net.
    const anaView = ana.tabBalances(circleId);
    const bobView = bob.tabBalances(circleId);
    expect(anaView).toEqual(bobView);
    expect(anaView.pairwise[B]?.[A]).toBe(1600);
    expect(anaView.expenses).toBe(2);

    // syncEvents is idempotent: replaying everything applies nothing new.
    expect((await bob.syncEvents(circleId)).applied).toBe(0);
  });

  it("answers ungranted asks with the default posture; granted asks wait for the human", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Ana asks the graph for a dentist. Bob's human granted nothing.
    const ask = await ana.askPeople({
      circleId,
      question: "does anyone know a good dentist in Austin?",
      category: "recommendations.dentist",
    });
    expect(ask.delivered).toEqual([pubkeyId(bobKey)]);

    const first = await bob.answerPendingAsks();
    expect(first).toEqual({ declined: 1, awaitingHuman: 0 });
    // Ana received the polite refusal, threaded to her ask.
    const anaInbox = ana.messages(circleId).filter((m) => m.direction === "in");
    expect(anaInbox).toHaveLength(1);
    expect(anaInbox[0]?.kind).toBe("answer");
    expect(anaInbox[0]?.threadId).toBe(ask.threadId);
    expect(anaInbox[0]?.content).toContain("I'll reply if they've allowed this topic");

    // The sweep is idempotent: the refusal answered the thread.
    expect(await bob.answerPendingAsks()).toEqual({ declined: 0, awaitingHuman: 0 });

    // Bob's human grants the category; Ana asks again -> waits for the human,
    // and NOTHING is auto-disclosed.
    setDisclosureGrant(bob.dbHandle, { category: "recommendations.dentist", allowed: true });
    await ana.askPeople({
      circleId,
      question: "asking again — dentist recs?",
      category: "recommendations.dentist",
    });
    expect(await bob.answerPendingAsks()).toEqual({ declined: 0, awaitingHuman: 1 });
    expect(ana.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(1);
  });
});

// PLAN-36 §4: mailbox-mediated join — the invitee completes a join WITHOUT the
// inviter being reachable, by depositing a sealed join request in the inviter's
// mailbox and receiving the signed `welcome` roster back through its own.
describe("CirclesService mailbox-mediated join (§4)", () => {
  let anaDb: DatabaseSync;
  let bobDb: DatabaseSync;
  let anaKey: KeyPair;
  let bobKey: KeyPair;

  beforeEach(() => {
    resetCircleRateLimits();
    resetMailboxRateLimits();
    anaDb = openDb();
    bobDb = openDb();
    anaKey = generateKeyPair();
    bobKey = generateKeyPair();
  });

  it("mints with a mailbox rendezvous when there is no a2a URL", () => {
    const ana = new CirclesService({
      db: anaDb,
      config: {
        circles: {
          enabled: true,
          displayName: "Ana",
          mailbox: { url: "https://relay.test", serve: false },
        },
      },
      fetchImpl: meshFetch({}),
      keyPair: anaKey,
      boxKeys: generateBoxKeyPair(),
    });
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    const parsed = parseInviteCode(invite.code);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.invite.inviterA2aUrl).toBe(""); // no direct URL advertised
      expect(parsed.invite.inviterMailboxUrl).toBe("https://relay.test");
      expect(parsed.invite.inviterBoxPubkey).not.toBe("");
    }
  });

  it("completes the join after the offline inviter drains and welcomes back", async () => {
    const relayDb = openDb();
    const offline = new Set<string>(["ana"]); // Ana is unreachable throughout the join
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb, relay: relayDb }, { offline });
    const anaBox = generateBoxKeyPair();
    const bobBox = generateBoxKeyPair();
    const ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana", "relay"),
      fetchImpl,
      keyPair: anaKey,
      boxKeys: anaBox,
    });
    const bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: bobBox,
    });

    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    const circleId = invite.circleId;

    // Bob redeems while Ana is offline: direct dial fails -> mailbox rendezvous.
    const pending = await bob.redeemInviteCode(invite.code);
    expect(pending.status).toBe("pending");
    expect(pending.members).toBe(0);
    expect(bob.listCircles().some((c) => c.circleId === circleId)).toBe(false);

    // The relay holds ONE sealed join request addressed to Ana (ciphertext only).
    const joinBlobs = relayDb
      .prepare(`SELECT recipient_pubkey, blob_json FROM mailbox_blobs`)
      .all() as Array<{ recipient_pubkey: string; blob_json: string }>;
    expect(joinBlobs).toHaveLength(1);
    expect(joinBlobs[0]?.recipient_pubkey).toBe(pubkeyId(anaKey));
    expect(joinBlobs[0]?.blob_json).not.toContain("circle/join"); // sealed, not plaintext

    // Ana comes online and drains: processes the join and mails the welcome back.
    offline.delete("ana");
    expect(await ana.pollMailbox()).toEqual({ received: 1, dispatched: 1 });
    expect(ana.store.getMembers(circleId).map((m) => m.memberPubkey)).toContain(pubkeyId(bobKey));
    // The join blob is acked; the relay now holds only the welcome, for Bob.
    const afterAna = relayDb.prepare(`SELECT recipient_pubkey FROM mailbox_blobs`).all() as Array<{
      recipient_pubkey: string;
    }>;
    expect(afterAna.map((b) => b.recipient_pubkey)).toEqual([pubkeyId(bobKey)]);

    // Bob drains: imports the signed welcome -> connected, roster mirrored, pending cleared.
    expect(await bob.pollMailbox()).toEqual({ received: 1, dispatched: 1 });
    expect(bob.listCircles().some((c) => c.circleId === circleId)).toBe(true);
    expect(
      bob.store
        .getMembers(circleId)
        .map((m) => m.memberPubkey)
        .toSorted(),
    ).toEqual([pubkeyId(anaKey), pubkeyId(bobKey)].toSorted());
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 0 });
    // Idempotent: a second Bob poll is a no-op.
    expect(await bob.pollMailbox()).toEqual({ received: 0, dispatched: 0 });
  });

  it("drops a welcome with no matching pending join (anti-injection)", async () => {
    const relayDb = openDb();
    const fetchImpl = meshFetch({ bob: bobDb, relay: relayDb });
    const bobBox = generateBoxKeyPair();
    const bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: bobBox,
    });

    // A stranger forges a validly-signed welcome for a circle Bob never asked to
    // join, seals it to Bob's box key, and drops it in Bob's mailbox.
    const strangerKey = generateKeyPair();
    const forged = makeCircleEnvelope(
      "welcome",
      "circle-bob-never-requested",
      {
        circle: {
          circleId: "circle-bob-never-requested",
          name: "Totally Legit",
          kind: "connection",
          creatorPubkey: pubkeyId(strangerKey),
          keyEpoch: 0,
          createdAt: Date.now(),
        },
        members: [],
      },
      strangerKey,
    );
    const blob = JSON.stringify(
      sealToBox(
        bobBox.publicKeyB64,
        JSON.stringify({ method: "circle/welcome", envelope: forged }),
      ),
    );
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(strangerKey),
      privateKey: strangerKey.privateKey,
      extra: blobDigest(pubkeyId(bobKey), blob),
    });
    const posted = handleMailboxMethod(
      "mailbox/post",
      { to: pubkeyId(bobKey), blob, proof },
      relayDb,
      Date.now(),
    );
    expect(posted.ok).toBe(true);

    // Bob drains: the welcome is acked (cleared) but NOT imported — no circle.
    expect(await bob.pollMailbox()).toEqual({ received: 1, dispatched: 0 });
    expect(bob.listCircles().some((c) => c.circleId === "circle-bob-never-requested")).toBe(false);
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 0 });
  });

  it("refuses an invite that reuses a known circle id under a different owner (review #1)", async () => {
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb });
    const ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    const bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });
    // Ana and Bob connect normally: Bob now knows circle X, created by Ana.
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Mallory forges an invite REUSING circle X's id, signed by Mallory's key —
    // an attempt to later overwrite Bob's view of Ana's circle (roster/endpoints).
    const malloryKey = generateKeyPair();
    const forged = createInvite(openDb(), {
      circleId,
      circleName: "Free Money",
      circleKind: "connection",
      inviterKey: malloryKey,
      inviterName: "Mallory",
      inviterA2aUrl: "https://mallory.test",
      scopes: DEFAULT_MEMBER_SCOPES,
    });
    await expect(bob.redeemInviteCode(forged.code)).rejects.toThrow(/another owner/);
    // Ana is still the sole owner; no Mallory membership leaked in.
    expect(bob.store.getCircle(circleId)?.creatorPubkey).toBe(pubkeyId(anaKey));
    expect(bob.store.getMembers(circleId).map((m) => m.memberPubkey)).not.toContain(
      pubkeyId(malloryKey),
    );
  });

  it("backs off re-posting a pending join instead of flooding the inviter (review #2)", async () => {
    const relayDb = openDb();
    const offline = new Set<string>(["ana"]);
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb, relay: relayDb }, { offline });
    const ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana", "relay"),
      fetchImpl,
      keyPair: anaKey,
      boxKeys: generateBoxKeyPair(),
    });
    const bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: generateBoxKeyPair(),
    });
    const pending = await bob.redeemInviteCode(ana.createInviteCode({ name: "Ana & Bob" }).code);
    expect(pending.status).toBe("pending");
    // The initial post is out; an immediate re-post is NOT due (30s backoff).
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 1 });
    expect(await bob.repostPendingJoins()).toBe(0);
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 1 });
    // Backoff schedule: 30s doubling to a 1h cap.
    expect(pendingJoinBackoffMs(1)).toBe(30_000);
    expect(pendingJoinBackoffMs(2)).toBe(60_000);
    expect(pendingJoinBackoffMs(99)).toBe(60 * 60_000);
  });

  it("drops (acks) an unauthorized generic blob rather than reprocessing forever (review #4)", async () => {
    const relayDb = openDb();
    const fetchImpl = meshFetch({ bob: bobDb, relay: relayDb });
    const bobBox = generateBoxKeyPair();
    const bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: bobBox,
    });
    // A stranger seals a circle/message for a circle Bob is NOT a member of.
    const strangerKey = generateKeyPair();
    const env = makeCircleEnvelope(
      "message",
      "ghost-circle",
      { content: "unauthorized", thread_id: "t1", kind: "message" },
      strangerKey,
    );
    const blob = JSON.stringify(
      sealToBox(bobBox.publicKeyB64, JSON.stringify({ method: "circle/message", envelope: env })),
    );
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(strangerKey),
      privateKey: strangerKey.privateKey,
      extra: blobDigest(pubkeyId(bobKey), blob),
    });
    handleMailboxMethod("mailbox/post", { to: pubkeyId(bobKey), blob, proof }, relayDb, Date.now());

    // Drain: unauthorized (not rate-limited) -> acked/dropped, not left to clog.
    expect(await bob.pollMailbox()).toEqual({ received: 1, dispatched: 0 });
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 0 });
    // A second drain sees nothing (the poison blob did not linger).
    expect(await bob.pollMailbox()).toEqual({ received: 0, dispatched: 0 });
  });
});
