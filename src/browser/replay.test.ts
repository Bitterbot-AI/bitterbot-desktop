import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplayRecorder,
  deleteReplaySession,
  listReplayFrames,
  listReplaySessions,
  readReplayFrame,
  REPLAY_MAX_FRAMES_PER_SESSION,
  REPLAY_MIN_GAP_MS,
  replaySessionId,
} from "./replay.js";

let stateDir: string;
let clock: number;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-replay-"));
  clock = 1_700_000_000_000;
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const recorder = (over: Partial<Parameters<typeof createReplayRecorder>[0]> = {}) =>
  createReplayRecorder({
    capture: vi.fn(async () => jpeg),
    stateDir,
    now: () => clock,
    ...over,
  });

describe("replay recorder", () => {
  it("records a frame after a page action and lists it back", async () => {
    const r = recorder();
    const frame = await r.record({
      sessionKey: "agent:main:main",
      action: "navigate",
      url: "https://a.com",
    });

    expect(frame).toMatchObject({ action: "navigate", url: "https://a.com" });
    const [session] = listReplaySessions(stateDir);
    expect(session).toMatchObject({ sessionKey: "agent:main:main", frames: 1 });
    expect(listReplayFrames(session.id, { stateDir })).toHaveLength(1);
    expect(readReplayFrame(session.id, frame!.file, stateDir)).toEqual(jpeg);
    // Windows has no POSIX modes.
    if (process.platform !== "win32") {
      const mode =
        fs.statSync(path.join(stateDir, "replays", session.id, frame!.file)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("skips read-only actions, throttles per session, and honours the off switch", async () => {
    const capture = vi.fn(async () => jpeg);
    let enabled = true;
    const r = recorder({ capture, enabled: () => enabled });
    expect(await r.record({ sessionKey: "s", action: "snapshot" })).toBeNull();
    expect(await r.record({ sessionKey: "s", action: "act" })).not.toBeNull();
    clock += REPLAY_MIN_GAP_MS - 1;
    expect(await r.record({ sessionKey: "s", action: "act" })).toBeNull();
    expect(await r.record({ sessionKey: "other", action: "act" })).not.toBeNull();
    clock += 10;
    enabled = false;
    expect(await r.record({ sessionKey: "s", action: "act" })).toBeNull();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("never throws when the capture fails", async () => {
    const r = recorder({ capture: async () => Promise.reject(new Error("no page")) });
    await expect(r.record({ sessionKey: "s", action: "open" })).resolves.toBeNull();
  });

  it("keeps only the newest frames per session", async () => {
    const r = recorder();
    for (let i = 0; i < REPLAY_MAX_FRAMES_PER_SESSION + 3; i++) {
      clock += REPLAY_MIN_GAP_MS;
      await r.record({ sessionKey: "s", action: "act" });
    }
    const id = replaySessionId("s");
    const frames = listReplayFrames(id, { stateDir });
    expect(frames).toHaveLength(REPLAY_MAX_FRAMES_PER_SESSION);
    const files = fs
      .readdirSync(path.join(stateDir, "replays", id))
      .filter((f) => f.endsWith(".jpg"));
    expect(files).toHaveLength(REPLAY_MAX_FRAMES_PER_SESSION);
  });

  it("drops recordings older than the retention window", async () => {
    const r = recorder({ retentionDays: () => 1 });
    await r.record({ sessionKey: "old", action: "act" });
    clock += 2 * 24 * 60 * 60 * 1000;
    await r.record({ sessionKey: "new", action: "act" });
    expect(listReplaySessions(stateDir).map((s) => s.sessionKey)).toEqual(["new"]);
  });
});

describe("replay readers", () => {
  it("refuses names that could leave the replay folder", async () => {
    await recorder().record({ sessionKey: "s", action: "act" });
    const id = replaySessionId("s");
    expect(readReplayFrame("..", "x.jpg", stateDir)).toBeNull();
    expect(readReplayFrame(id, "../session.json", stateDir)).toBeNull();
    expect(listReplayFrames("../x", { stateDir })).toEqual([]);
    expect(deleteReplaySession("../replays", stateDir)).toBe(false);
    expect(deleteReplaySession(id, stateDir)).toBe(true);
    expect(listReplaySessions(stateDir)).toEqual([]);
  });

  it("gives every session key a distinct safe folder", () => {
    expect(replaySessionId("agent:main:telegram:dm:42")).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(replaySessionId("a/b")).not.toBe(replaySessionId("a:b"));
  });
});
