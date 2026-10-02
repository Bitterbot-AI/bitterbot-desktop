import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserControl,
  isUserInControl,
  releaseBrowserControl,
  resetBrowserControlForTest,
  takeBrowserControl,
  TAKEOVER_IDLE_MS,
  touchBrowserControl,
  waitForAgentControl,
} from "./takeover.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  resetBrowserControlForTest();
});

afterEach(() => {
  resetBrowserControlForTest();
  vi.useRealTimers();
});

describe("browser takeover", () => {
  it("is the agent's browser until someone takes it", () => {
    expect(isUserInControl("bitterbot")).toBe(false);
    expect(getBrowserControl()).toBeNull();
  });

  it("never reports control for a caller with no profile name", () => {
    // Regression: `undefined === undefined` once held every agent action in a
    // context whose profile had no name, with nobody in control at all.
    expect(isUserInControl(undefined as unknown as string)).toBe(false);
    takeBrowserControl("bitterbot", "conn-1");
    expect(isUserInControl(undefined as unknown as string)).toBe(false);
  });

  it("applies to the profile that was taken, not to every profile", () => {
    takeBrowserControl("bitterbot", "conn-1");

    expect(isUserInControl("bitterbot")).toBe(true);
    expect(isUserInControl("work")).toBe(false);
  });

  it("lets a waiting agent through the moment control is handed back", async () => {
    takeBrowserControl("bitterbot", "conn-1");
    const waiting = waitForAgentControl("bitterbot", 60_000);

    await vi.advanceTimersByTimeAsync(2_500);
    releaseBrowserControl();

    await expect(waiting).resolves.toBe(false);
  });

  it("tells the agent it is still blocked when the wait runs out", async () => {
    takeBrowserControl("bitterbot", "conn-1");
    const waiting = waitForAgentControl("bitterbot", 5_000);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(waiting).resolves.toBe(true);
    expect(isUserInControl("bitterbot")).toBe(true);
  });

  it("does not hold an agent acting on a different profile", async () => {
    takeBrowserControl("bitterbot", "conn-1");

    await expect(waitForAgentControl("work", 5_000)).resolves.toBe(false);
  });

  it("hands back by itself when the person goes quiet", async () => {
    // Someone takes over, then walks away. The agent must not stay frozen.
    takeBrowserControl("bitterbot", "conn-1");
    const waiting = waitForAgentControl("bitterbot", TAKEOVER_IDLE_MS + 10_000);

    await vi.advanceTimersByTimeAsync(TAKEOVER_IDLE_MS);

    await expect(waiting).resolves.toBe(false);
    expect(getBrowserControl()).toBeNull();
  });

  it("stays with a person who keeps interacting", async () => {
    takeBrowserControl("bitterbot", "conn-1");

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(TAKEOVER_IDLE_MS / 2);
      touchBrowserControl();
    }

    expect(isUserInControl("bitterbot")).toBe(true);
  });

  it("reports whether a release actually ended anything", () => {
    expect(releaseBrowserControl()).toBe(false);
    takeBrowserControl("bitterbot", "conn-1");
    expect(releaseBrowserControl()).toBe(true);
  });
});
