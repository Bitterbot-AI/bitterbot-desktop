import { afterEach, describe, expect, it } from "vitest";
import type { CircleTopicBridge } from "./circle-topic.js";
import {
  getCircleTopicBus,
  setCircleTopicBusForTests,
  startCircleTopicTransport,
} from "./circle-topic-transport.js";

// Stage 1 of the P2P transport plan: a daemon that cannot serve the topic
// verbs (pre-0.2.0 never answers; the bridge times out after 2s) must cost
// that timeout ONCE, not on every publish and every scheduler cycle — the
// transport latches the mesh bus off and delivery continues over HTTP.

function makeBridge(overrides: Partial<CircleTopicBridge> = {}): CircleTopicBridge {
  return {
    subscribeCircleTopic: async () => ({}),
    unsubscribeCircleTopic: async () => ({}),
    publishCircleTopic: async () => ({}),
    onCircleTopicMessage: () => () => {},
    ...overrides,
  };
}

const TOPIC = `bitterbot/circle/${"a".repeat(64)}/v1`;

afterEach(() => {
  setCircleTopicBusForTests(null);
});

describe("circle topic transport capability latch", () => {
  it("latches the bus off after an IPC timeout and stops calling the daemon", async () => {
    let publishCalls = 0;
    const handle = startCircleTopicTransport({
      bridge: makeBridge({
        publishCircleTopic: async () => {
          publishCalls += 1;
          throw new Error("IPC command publish_topic timed out");
        },
      }),
      resolveCirclesDb: async () => undefined,
    });
    const bus = getCircleTopicBus();
    expect(bus).not.toBeNull();

    // First call eats the failure and disables the bus…
    await bus!.publish(TOPIC, "{}");
    expect(getCircleTopicBus()).toBeNull();
    // …and further calls through a retained reference are no-ops.
    await bus!.publish(TOPIC, "{}");
    await bus!.subscribe(TOPIC);
    expect(publishCalls).toBe(1);
    handle.stop();
  });

  it("latches on an explicit unknown-verb answer from a future daemon", async () => {
    const handle = startCircleTopicTransport({
      bridge: makeBridge({
        subscribeCircleTopic: async () => {
          throw new Error("unknown message type: subscribe_topic");
        },
      }),
      resolveCirclesDb: async () => undefined,
    });
    const bus = getCircleTopicBus();
    await bus!.subscribe(TOPIC);
    expect(getCircleTopicBus()).toBeNull();
    handle.stop();
  });

  it("propagates ordinary errors without latching (transient failures retry)", async () => {
    const handle = startCircleTopicTransport({
      bridge: makeBridge({
        publishCircleTopic: async () => {
          throw new Error("gossipsub publish failed: InsufficientPeers");
        },
      }),
      resolveCirclesDb: async () => undefined,
    });
    const bus = getCircleTopicBus();
    await expect(bus!.publish(TOPIC, "{}")).rejects.toThrow(/InsufficientPeers/);
    // Not a capability problem — the bus stays available for the next send.
    expect(getCircleTopicBus()).not.toBeNull();
    handle.stop();
  });

  it("keeps serving verbs when the daemon answers them", async () => {
    const seen: string[] = [];
    const handle = startCircleTopicTransport({
      bridge: makeBridge({
        publishCircleTopic: async (topic) => {
          seen.push(topic);
          return {};
        },
      }),
      resolveCirclesDb: async () => undefined,
    });
    const bus = getCircleTopicBus();
    await bus!.publish(TOPIC, "{}");
    await bus!.publish(TOPIC, "{}");
    expect(seen).toHaveLength(2);
    expect(getCircleTopicBus()).not.toBeNull();
    handle.stop();
  });
});
