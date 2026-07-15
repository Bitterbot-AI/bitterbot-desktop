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
  type CircleTopicBridge,
  type CircleTopicBus,
} from "./circle-topic.js";

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
export function startCircleTopicTransport(deps: {
  bridge: CircleTopicBridge;
  /**
   * Resolve the circles DB lazily/async (the memory manager may still be
   * building at startup, and inbound frames are infrequent).
   */
  resolveCirclesDb: () => Promise<DatabaseSync | undefined>;
}): { stop: () => void } {
  const bus = bridgeCircleTopicBus(deps.bridge);
  activeBus = bus;
  const unsub = onBridgeCircleFrame(deps.bridge, (frameJson, topic) => {
    void (async () => {
      const db = await deps.resolveCirclesDb();
      if (!db) return; // manager not ready — drop; gossip re-gossips / mailbox backstops
      const res = receiveCircleFrame(frameJson, db);
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
