/**
 * P2P bounty task plumbing (PLAN-16 Phase E.4 — stub).
 *
 * **What this file is**
 *
 * The Task primitive includes an optional `bounty` field (cents). When
 * a task is created with `bounty > 0`, it is eligible to be propagated
 * over the Bitterbot orchestrator's P2P mesh so peers in the trust
 * quorum can claim and execute portions. The Judge (Phase D) verifies
 * the result before any value transfer; if the Judge rejects, the task
 * is reopened and no payout is owed.
 *
 * **What this file is NOT**
 *
 * This file ships **no wallet, no funding, no payment flow**. Per
 * repository policy (see memory: feedback_wallet_code_restricted),
 * wallet integration is owned by the project lead. The orchestrator
 * P2P bidding/claim/verification half can be implemented and merged;
 * the payout half is held back.
 *
 * **The actual integration**
 *
 * 1. `listBiddableTasks()` — surfaces open `bounty > 0` tasks for the
 *    orchestrator to gossip onto pubsub. Already implementable today.
 *
 * 2. `recordBid({taskId, peerId, signedOffer})` — records an inbound
 *    peer bid against a task. Stores in the task's metadata under
 *    `bids[]`. Already implementable today.
 *
 * 3. `acceptBid({taskId, peerId})` — transitions the task to
 *    `waiting_external` with metadata.acceptedPeer set; informs the
 *    orchestrator to send a signed acceptance frame to the peer.
 *
 * 4. `recordPeerOutput({taskId, peerId, output, proof})` — peer
 *    reports completion; the local Judge takes over and verifies.
 *
 * 5. **Payout** is the held-back step. After Judge `pass`, the gateway
 *    would normally invoke the wallet to settle. This file does not
 *    implement that.
 *
 * The code below is the minimum scaffolding for steps 1–2; 3–4 land
 * once the orchestrator pubsub channel for `task_bounty` is plumbed.
 */

import type { Task } from "./types.js";
import { getActiveTaskStore } from "./store.js";

export type BiddableTaskSummary = {
  taskId: string;
  goal: string;
  doneCriteria: string;
  bounty: number;
  status: Task["status"];
  /** Peers that have submitted a signed bid so far. */
  bidCount: number;
};

/**
 * List tasks eligible for P2P bidding: bounty > 0, not terminal, not
 * already assigned to a peer.
 */
export function listBiddableTasks(): BiddableTaskSummary[] {
  const store = getActiveTaskStore();
  if (!store) return [];
  return store
    .list({ status: ["pending", "planning", "running", "waiting_external"], limit: 200 })
    .filter((t) => typeof t.bounty === "number" && t.bounty > 0)
    .filter((t) => !readAcceptedPeer(t))
    .map((t) => ({
      taskId: t.id,
      goal: t.goal,
      doneCriteria: t.doneCriteria,
      bounty: t.bounty ?? 0,
      status: t.status,
      bidCount: readBids(t).length,
    }));
}

export type PeerBid = {
  peerId: string;
  /** Stringified signature payload — orchestrator verifies on inbound. */
  signedOffer: string;
  /** Peer's offered price in cents. May be lower than the bounty. */
  offerCents: number;
  receivedAt: number;
};

export function recordBid(args: {
  taskId: string;
  peerId: string;
  signedOffer: string;
  offerCents: number;
}): { ok: boolean; error?: string; bidCount?: number } {
  const store = getActiveTaskStore();
  if (!store) return { ok: false, error: "task store not active" };
  const task = store.get(args.taskId);
  if (!task) return { ok: false, error: `task ${args.taskId} not found` };
  if (typeof task.bounty !== "number" || task.bounty <= 0) {
    return { ok: false, error: "task has no bounty; not biddable" };
  }
  if (readAcceptedPeer(task)) {
    return { ok: false, error: "task already accepted by a peer" };
  }
  const bid: PeerBid = {
    peerId: args.peerId,
    signedOffer: args.signedOffer,
    offerCents: args.offerCents,
    receivedAt: Date.now(),
  };
  const bids = readBids(task);
  bids.push(bid);
  const meta = { ...task.metadata, bids };
  store.update(args.taskId, { metadata: meta });
  return { ok: true, bidCount: bids.length };
}

/** Operator-facing helper for inspecting outstanding bids on a task. */
export function getBids(taskId: string): PeerBid[] {
  const store = getActiveTaskStore();
  if (!store) return [];
  const task = store.get(taskId);
  if (!task) return [];
  return readBids(task);
}

function readBids(task: Task): PeerBid[] {
  const raw = (task.metadata as Record<string, unknown> | null)?.bids;
  return Array.isArray(raw) ? (raw as PeerBid[]) : [];
}

function readAcceptedPeer(task: Task): string | null {
  const raw = (task.metadata as Record<string, unknown> | null)?.acceptedPeer;
  return typeof raw === "string" ? raw : null;
}
