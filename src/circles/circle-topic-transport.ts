/**
 * PLAN-36 Phase 4: the circles-service integration for the gossip-topic
 * transport.
 *
 * The Rust primitive + bridge (circle-topic.ts, orchestrator/*) give us a
 * dynamic per-circle pub/sub. This module is the glue that makes the running
 * node actually use it:
 *  - holds the active CircleTopicBus as a process singleton so any
 *    CirclesService (constructed per-call in RPC/tool paths) can publish over
 *    the mesh without threading the orchestrator bridge through every caller;
 *  - wires inbound `topic_message` frames into `receiveCircleFrame` against the
 *    circles DB.
 *
 * It is entirely optional: until a node runs the new orchestrator build,
 * `startCircleTopicTransport` is simply never called and `getCircleTopicBus()`
 * returns null, so the service falls back to the direct-dial + mailbox paths
 * exactly as before.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  bridgeCircleTopicBus,
  onBridgeCircleFrame,
  receiveCircleFrame,
  resolveTopicCircle,
  type CircleTopicBridge,
  type CircleTopicBus,
} from "./circle-topic.js";
import { decryptTopicFrame, parseEncryptedTopicFrame } from "./sender-keys.js";

const log = createSubsystemLogger("circles/topic-transport");

let activeBus: CircleTopicBus | null = null;

/** The active mesh topic bus, or null when no orchestrator transport is up. */
export function getCircleTopicBus(): CircleTopicBus | null {
  return activeBus;
}

/** Test hook: install/clear a bus without an orchestrator. */
export function setCircleTopicBusForTests(bus: CircleTopicBus | null): void {
  activeBus = bus;
}

/**
 * Start the topic transport: install the bus singleton and wire inbound frames
 * into the circles DB. Call once at gateway startup when the orchestrator
 * bridge is available. Returns a handle whose stop() unwires it.
 */
/**
 * An error that proves the running daemon cannot serve topic verbs: a
 * pre-0.2.0 orchestrator never answers them at all (the bridge's short topic
 * timeout fires), and a future daemon that dropped a verb answers "unknown
 * message type". Either way, retrying every send/scheduler-cycle would cost
 * the timeout each time — latch the bus off instead.
 */
function isTopicCapabilityError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("timed out") || msg.includes("unknown message type");
}

export function startCircleTopicTransport(deps: {
  bridge: CircleTopicBridge;
  /**
   * Resolve the circles DB lazily/async (the memory manager may still be
   * building at startup, and inbound frames are infrequent).
   */
  resolveCirclesDb: () => Promise<DatabaseSync | undefined>;
}): { stop: () => void } {
  const raw = bridgeCircleTopicBus(deps.bridge);
  // Capability latch: the first verb the daemon provably cannot serve
  // disables the mesh bus for this process (HTTP dial + mailbox delivery are
  // unaffected — the mesh is additive). Without this, a gateway with
  // circles.meshTopic.enabled pointed at an old daemon stalls on every
  // publish and on every circle's subscribe each scheduler cycle.
  let latchedOff = false;
  const guard = async (op: () => Promise<void>): Promise<void> => {
    if (latchedOff) return;
    try {
      await op();
    } catch (err) {
      if (isTopicCapabilityError(err)) {
        latchedOff = true;
        if (activeBus === bus) activeBus = null;
        log.warn(
          "orchestrator daemon does not serve circle topic verbs " +
            "(pre-0.2.0 build?) — mesh path disabled for this run; " +
            `direct dial + mailbox delivery unaffected (${String(err)})`,
        );
        return;
      }
      throw err;
    }
  };
  const bus: CircleTopicBus = {
    publish: (topic, frameJson) => guard(() => raw.publish(topic, frameJson)),
    subscribe: (topic) => guard(() => raw.subscribe(topic)),
    unsubscribe: (topic) => guard(() => raw.unsubscribe(topic)),
  };
  activeBus = bus;
  const unsub = onBridgeCircleFrame(deps.bridge, (frameJson, topic) => {
    void (async () => {
      const db = await deps.resolveCirclesDb();
      if (!db) return; // manager not ready — drop; gossip re-gossips / mailbox backstops
      // Stage 2: encrypted frames (the norm from 0.2.0+ senders) decrypt with
      // the sender key that member distributed over dial/mailbox. No key yet
      // (or tampered) → drop at debug; the HTTP copy of the same envelope
      // delivers, and the key converges via the scheduler's distribution
      // sweep. Legacy plaintext frames still dispatch (fleet transition).
      let inner = frameJson;
      const wrapper = parseEncryptedTopicFrame(frameJson);
      if (wrapper) {
        const circleId = resolveTopicCircle(db, topic);
        const dec = circleId ? decryptTopicFrame(db, { circleId, topicId: topic, wrapper }) : null;
        if (!dec) {
          log.debug(
            `encrypted frame on ${topic} from ${wrapper.s.slice(0, 24)}… undecryptable (no sender key yet?) — dropped; HTTP copy delivers`,
          );
          return;
        }
        inner = dec;
      }
      const res = receiveCircleFrame(inner, db);
      if (!res.ok) log.debug(`inbound circle frame on ${topic} rejected: ${res.error}`);
    })();
  });
  log.info("circle topic transport active (mesh delivery for circle messages)");
  return {
    stop: () => {
      unsub();
      if (activeBus === bus) activeBus = null;
    },
  };
}
