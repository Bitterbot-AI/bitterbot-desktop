import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeHandoffOutcome, type HandoffDeps, runBrowserHandoff } from "./handoff.js";
import { ReviewService } from "./service.js";
import { ReviewStore } from "./store.js";

/**
 * The wait at the heart of the handoff: a fake clock, a real store, and a
 * script of what the owner does at which poll.
 */

let dir: string;
let store: ReviewStore;
let service: ReviewService;
let events: Array<{ event: string; status: string }>;
let clock: number;
let inControl: boolean;
let polls: number;
/** Runs before each poll's sleep returns; the "owner" acts here. */
let onPoll: (poll: number) => void;

const deps = (): HandoffDeps => ({
  service,
  isUserInControl: () => inControl,
  now: () => clock,
  sleep: async (ms) => {
    clock += ms;
    polls += 1;
    onPoll(polls);
  },
});

const ARGS = {
  reason: "Log in to the shop",
  profile: "bitterbot",
  url: "https://shop.test/login",
  ctx: { sessionKey: "agent:main:main" },
  acceptMs: 10_000,
  maxMs: 30_000,
  pollMs: 1_000,
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-handoff-"));
  clock = 1_000_000;
  store = ReviewStore.open(path.join(dir, "review.sqlite"), () => clock);
  events = [];
  inControl = false;
  polls = 0;
  onPoll = () => {};
  let n = 0;
  service = new ReviewService({
    store,
    executors: new Map(),
    broadcast: (event, payload) =>
      events.push({ event, status: (payload as { status: string }).status }),
    now: () => clock,
    newId: () => `rv-0000000${++n}`,
  });
});

afterEach(async () => {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runBrowserHandoff", () => {
  it("asks, waits for the owner to take over, and returns when they hand back", async () => {
    onPoll = (poll) => {
      if (poll === 2) inControl = true;
      if (poll === 7) inControl = false;
    };

    const outcome = await runBrowserHandoff(ARGS, deps());

    expect(outcome).toEqual({ kind: "completed", id: "rv-00000001", seconds: 5 });
    const row = store.get("rv-00000001");
    expect(row).toMatchObject({
      cls: "handoff",
      tool: "browser",
      status: "executed",
      decidedVia: "takeover",
      sessionKey: "agent:main:main",
      preview: "Take over the browser: Log in to the shop (https://shop.test/login)",
    });
    expect(row?.resultSummary).toContain("handed it back");
    expect(events).toEqual([
      { event: "review.requested", status: "pending" },
      { event: "review.resolved", status: "approved" },
      { event: "review.resolved", status: "executed" },
    ]);
  });

  it("returns as soon as the owner declines", async () => {
    onPoll = (poll) => {
      if (poll === 3) {
        void service.resolve("rv-00000001", "deny", { decidedBy: "owner", decidedVia: "test" });
      }
    };

    const outcome = await runBrowserHandoff(ARGS, deps());

    expect(outcome).toEqual({ kind: "declined", id: "rv-00000001" });
    expect(polls).toBe(3);
    expect(store.get("rv-00000001")?.status).toBe("denied");
  });

  it("gives up when nobody takes over, and closes the request", async () => {
    const outcome = await runBrowserHandoff(ARGS, deps());

    expect(outcome).toEqual({ kind: "timed_out", id: "rv-00000001" });
    expect(store.get("rv-00000001")?.status).toBe("expired");
    expect(store.pendingCount()).toBe(0);
    expect(events.at(-1)).toEqual({ event: "review.resolved", status: "expired" });
  });

  it("does not leave an accepted request open when the browser was never taken", async () => {
    onPoll = (poll) => {
      if (poll === 1) {
        void service.resolve("rv-00000001", "approve", { decidedBy: "owner", decidedVia: "chat" });
      }
    };

    const outcome = await runBrowserHandoff(ARGS, deps());

    expect(outcome.kind).toBe("timed_out");
    expect(store.get("rv-00000001")).toMatchObject({ status: "failed" });
  });

  it("stops waiting on a long takeover and says the owner still has the browser", async () => {
    onPoll = (poll) => {
      if (poll === 1) inControl = true;
    };

    const outcome = await runBrowserHandoff(ARGS, deps());

    expect(outcome).toEqual({ kind: "still_in_control", id: "rv-00000001" });
    expect(clock - 1_000_000).toBe(30_000);
    expect(store.get("rv-00000001")?.status).toBe("executed");
  });

  it("closes the request when the run is stopped", async () => {
    const abort = new AbortController();
    onPoll = (poll) => {
      if (poll === 2) abort.abort();
    };

    await expect(runBrowserHandoff({ ...ARGS, signal: abort.signal }, deps())).rejects.toThrow(
      /stopped/,
    );
    expect(store.get("rv-00000001")?.status).toBe("expired");
  });

  it("approving a handoff never looks for an executor", async () => {
    const { action } = service.openHandoff({
      reason: "Solve the CAPTCHA",
      profile: "bitterbot",
      ctx: {},
      ttlMs: 10_000,
    });

    const resolved = await service.resolve(action.id, "approve", {
      decidedBy: "owner",
      decidedVia: "control-ui",
    });

    expect(resolved?.status).toBe("approved");
    expect(resolved?.resultSummary).toBeNull();
  });

  it("tells the agent what to do next for every outcome", () => {
    expect(describeHandoffOutcome({ kind: "completed", id: "rv-1", seconds: 12 })).toContain(
      "fresh snapshot",
    );
    expect(describeHandoffOutcome({ kind: "still_in_control", id: "rv-1" })).toContain(
      "Do not act on the page",
    );
    expect(describeHandoffOutcome({ kind: "declined", id: "rv-1" })).toContain("Do not ask again");
    expect(describeHandoffOutcome({ kind: "timed_out", id: "rv-1" })).toContain("Take over");
  });
});
