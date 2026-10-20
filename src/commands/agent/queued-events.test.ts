import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import {
  enqueueSystemEvent,
  hasSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { withQueuedSystemEvents } from "./queued-events.js";

const cfg = {} as BitterbotConfig;
const KEY = "agent:main:main";

beforeEach(() => {
  resetSystemEventsForTest();
});

describe("withQueuedSystemEvents", () => {
  it("puts queued notices in front of the prompt and takes them off the queue", async () => {
    enqueueSystemEvent("[review] Denied (rv-00000001): Send 5 USDC to 0xabc. Do not retry it.", {
      sessionKey: KEY,
    });

    const body = await withQueuedSystemEvents({ cfg, sessionKey: KEY, body: "what happened?" });

    expect(body).toMatch(/^System: \[.+\] \[review\] Denied \(rv-00000001\)/);
    expect(body.endsWith("\n\nwhat happened?")).toBe(true);
    expect(hasSystemEvents(KEY)).toBe(false);
  });

  it("leaves the prompt alone when nothing is queued, or the queue is another session's", async () => {
    enqueueSystemEvent("for someone else", { sessionKey: "agent:other:main" });

    expect(await withQueuedSystemEvents({ cfg, sessionKey: KEY, body: "hi" })).toBe("hi");
    expect(await withQueuedSystemEvents({ cfg, sessionKey: undefined, body: "hi" })).toBe("hi");
    expect(hasSystemEvents("agent:other:main")).toBe(true);
  });
});
