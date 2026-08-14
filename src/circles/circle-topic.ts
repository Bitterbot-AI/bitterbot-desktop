/**
 * PLAN-36 Phase 4 (PROTOTYPE): circle messaging over a per-circle gossip topic.
 *
 * WHY: today circle messages ride HTTP A2A, so a NAT'd node needs a public
 * `a2aPublicUrl` and two NAT'd home nodes can't reach each other at all. But the
 * node ALREADY holds a live libp2p connection to every peer through the relay
 * fleet. Gossipsub traverses those relays and reaches every subscriber — so a
 * per-circle topic gives us NAT-to-NAT circle delivery reusing infrastructure
 * that already works, with far less effort than a full libp2p request-response
 * protocol.
 *
 * WHAT THIS MODULE IS: the application-layer half — deriving the (blinded) topic
 * and moving a signed circle verb onto/off it, dispatched through the SAME
 * authenticated path as a direct dial or a mailbox drain. It is transport-
 * agnostic on purpose: the mailbox replay already proves handleCircleMethod
 * accepts any carrier.
 *
 * WHAT IS STILL NEEDED (the Rust slice, spec'd in docs/network/circle-gossip.md):
 *  1. A dynamic subscribe/publish primitive in the orchestrator — gossipsub
 *     topics are compile-time constants today. Needs IpcCommand::{Subscribe,
 *     Unsubscribe,Publish}Topic + a `topic_message` IPC event, wired to
 *     `gossipsub.subscribe/unsubscribe/publish`.
 *  2. CONFIDENTIALITY. A gossip topic is broadcast to whoever subscribes, and
 *     the blinded name only *hides* the circle id — it is not encryption. Real
 *     privacy needs a per-circle SHARED symmetric key (established at join,
 *     rotated on membership change — this is what finally CONSUMES `key_epoch`).
 *     Until then, frames are signed+authentic but not confidential over the
 *     shared mesh; this prototype proves transport, not privacy.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { CircleEnvelope } from "./envelope.js";
import { handleCircleMethod } from "../gateway/a2a/circles.js";

/**
 * Blinded gossip topic for a circle. Hashing `circleId:keyEpoch` keeps the raw
 * circle id off the wire so the mesh can't enumerate circles by name, and ties
 * the topic to the current membership epoch — a removed member's stale
 * subscription lands on the wrong (old-epoch) topic once key_epoch bumps. (This
 * gives the currently wired-but-dead `key_epoch` its first real consumer.)
 *
 * LIMIT: this hides the id from casual enumeration but is not unlinkability —
 * anyone who learns `circleId+keyEpoch` can recompute it. Full unlinkability
 * needs a rotating per-circle secret (see the module header).
 */
export function circleTopicId(circleId: string, keyEpoch: number): string {
  const h = crypto.createHash("sha256").update(`${circleId}:${keyEpoch}`).digest("hex");
  return `bitterbot/circle/${h}/v1`;
}

/**
 * The dynamic pub/sub primitive a circle uses to reach members over the mesh.
 * Implemented by the orchestrator bridge once the Rust slice lands; a fake bus
 * stands in for tests.
 */
export interface CircleTopicBus {
  publish(topic: string, frameJson: string): Promise<void>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

/** A frame carried on a circle topic: the circle verb + its signed envelope. */
export interface CircleTopicFrame {
  method: string; // "circle/message" | "circle/ask" | "circle/presence" | ...
  envelope: CircleEnvelope;
}

/** Publish a signed circle verb onto the circle's blinded topic. */
/**
 * Map a blinded topic id back to the local circle it belongs to (a receiver
 * knows its own circles + epochs, so it can recompute every topic name — the
 * blinding only defeats OUTSIDE enumeration). Null for unknown topics.
 */
export function resolveTopicCircle(db: DatabaseSync, topic: string): string | null {
  const rows = db
    .prepare(`SELECT circle_id, key_epoch FROM circles WHERE status = 'active'`)
    .all() as unknown as Array<{ circle_id: string; key_epoch: number }>;
  for (const r of rows) {
    if (circleTopicId(r.circle_id, r.key_epoch) === topic) {
      return r.circle_id;
    }
  }
  return null;
}

export async function publishCircleFrame(
  bus: CircleTopicBus,
  circleId: string,
  keyEpoch: number,
  method: string,
  envelope: CircleEnvelope,
): Promise<void> {
  const frame: CircleTopicFrame = { method, envelope };
  await bus.publish(circleTopicId(circleId, keyEpoch), JSON.stringify(frame));
}

/**
 * The orchestrator-bridge surface this adapter needs (matches the methods
 * added to OrchestratorBridge for the Rust dynamic pub/sub primitive).
 */
export interface CircleTopicBridge {
  subscribeCircleTopic(topic: string): Promise<unknown>;
  unsubscribeCircleTopic(topic: string): Promise<unknown>;
  publishCircleTopic(topic: string, dataB64: string): Promise<unknown>;
  onCircleTopicMessage(
    cb: (e: { topic: string; from_peer_id: string; data_b64: string }) => void,
  ): () => void;
}

/**
 * Adapt the bridge to the CircleTopicBus the app layer codes against. Frames
 * cross the IPC/gossip boundary as base64 (future-proof for encrypted binary
 * frames once the shared circle key lands).
 */
export function bridgeCircleTopicBus(bridge: CircleTopicBridge): CircleTopicBus {
  return {
    async publish(topic, frameJson) {
      await bridge.publishCircleTopic(topic, Buffer.from(frameJson, "utf-8").toString("base64"));
    },
    async subscribe(topic) {
      await bridge.subscribeCircleTopic(topic);
    },
    async unsubscribe(topic) {
      await bridge.unsubscribeCircleTopic(topic);
    },
  };
}

/**
 * Wire inbound bridge `topic_message` events into a circle-frame dispatcher
 * (which decodes base64 and hands the frame JSON to `receiveCircleFrame` with
 * the right circle DB). Returns an unsubscribe.
 */
export function onBridgeCircleFrame(
  bridge: CircleTopicBridge,
  dispatch: (frameJson: string, topic: string, fromPeerId: string) => void,
): () => void {
  return bridge.onCircleTopicMessage((e) => {
    dispatch(Buffer.from(e.data_b64, "base64").toString("utf-8"), e.topic, e.from_peer_id);
  });
}

export type ReceiveResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Handle a frame received on a circle topic. Dispatches through the SAME
 * authenticated `handleCircleMethod` path as any other carrier, so membership +
 * scope + injection scan + envelope dedupe all apply identically — a hostile
 * frame published to the topic by a non-member is rejected exactly as a hostile
 * HTTP dial would be. The self-published copy is dropped by the envelope-id
 * dedupe already in that path.
 */
export function receiveCircleFrame(
  frameJson: string,
  db: DatabaseSync,
  now: number = Date.now(),
): ReceiveResult {
  let frame: CircleTopicFrame;
  try {
    frame = JSON.parse(frameJson) as CircleTopicFrame;
  } catch {
    return { ok: false, error: "unparseable topic frame" };
  }
  if (typeof frame?.method !== "string" || !frame.method.startsWith("circle/") || !frame.envelope) {
    return { ok: false, error: "not a circle frame" };
  }
  const outcome = handleCircleMethod(frame.method, { envelope: frame.envelope }, db, now);
  return outcome.ok
    ? { ok: true, result: outcome.result }
    : { ok: false, error: outcome.error?.message ?? "rejected" };
}
