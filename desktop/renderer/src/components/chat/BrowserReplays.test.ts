import { describe, expect, it } from "vitest";
import { replayFor } from "./ActivityPanel";
import { describeSession, nearestFrameIndex, type ReplaySession } from "./BrowserReplays";

const session = (o: Partial<ReplaySession>): ReplaySession => ({
  id: "x",
  sessionKey: "agent:main:main",
  frames: 3,
  firstTs: 1_000_000,
  lastTs: 2_000_000,
  ...o,
});

describe("browser replays", () => {
  it("opens at the frame nearest a moment", () => {
    const frames = [10, 20, 30].map((ts) => ({ ts, file: `${ts}.jpg`, action: "act" }));
    expect(nearestFrameIndex(frames, 21)).toBe(1);
    expect(nearestFrameIndex(frames, 1000)).toBe(2);
    expect(nearestFrameIndex([], 5)).toBe(0);
  });

  it("names a session by its channel part", () => {
    expect(describeSession("agent:main:telegram:dm:42")).toBe("telegram · dm · 42");
    expect(describeSession("main")).toBe("main");
  });

  it("links an activity item to the recording of its session and time", () => {
    const replays = [session({ id: "a" }), session({ id: "b", sessionKey: "agent:main:other" })];
    expect(replayFor(replays, { sessionKey: "agent:main:main", createdAt: 1_500_000 })?.id).toBe(
      "a",
    );
    expect(
      replayFor(replays, { sessionKey: "agent:main:main", createdAt: 99_000_000 }),
    ).toBeUndefined();
    expect(replayFor(replays, { sessionKey: null, createdAt: 1_500_000 })).toBeUndefined();
  });
});
