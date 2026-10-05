import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drainSystemEvents,
  enableSystemEventPersistence,
  enqueueSystemEvent,
  flushSystemEventPersistence,
  peekSystemEvents,
  resetSystemEventsForTest,
  SYSTEM_EVENT_MAX_AGE_MS,
} from "./system-events.js";

/**
 * PLAN-53 E7: what is queued for a session is often something the owner was
 * promised. A restart must not drop it.
 */

let file: string;
const KEY = "agent:main:main";

/** What a new gateway process would see. */
const restart = (now = Date.now()) => {
  flushSystemEventPersistence();
  resetSystemEventsForTest();
  return enableSystemEventPersistence(file, now);
};

beforeEach(() => {
  resetSystemEventsForTest();
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-sysevents-")), "events.json");
});

afterEach(() => {
  resetSystemEventsForTest();
});

describe("system event persistence", () => {
  it("brings queued events back after a restart, in order", () => {
    enableSystemEventPersistence(file);
    enqueueSystemEvent("[review] Approved and done (rv-1)", { sessionKey: KEY });
    enqueueSystemEvent("Time to stretch", { sessionKey: KEY, contextKey: "cron:j1" });
    enqueueSystemEvent("for another session", { sessionKey: "agent:main:telegram:group:1" });

    expect(restart()).toBe(3);
    expect(peekSystemEvents(KEY)).toEqual(["[review] Approved and done (rv-1)", "Time to stretch"]);
  });

  it("does not bring back what was already delivered", () => {
    enableSystemEventPersistence(file);
    enqueueSystemEvent("delivered", { sessionKey: KEY });
    expect(drainSystemEvents(KEY)).toEqual(["delivered"]);

    expect(restart()).toBe(0);
    expect(peekSystemEvents(KEY)).toEqual([]);
  });

  it("drops events too old to be news, and stops saving them", () => {
    enableSystemEventPersistence(file);
    enqueueSystemEvent("yesterday's reminder", { sessionKey: KEY });

    expect(restart(Date.now() + SYSTEM_EVENT_MAX_AGE_MS + 1)).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions).toEqual({});
  });

  it("starts empty from a missing or damaged file without failing", () => {
    expect(enableSystemEventPersistence(file)).toBe(0);
    resetSystemEventsForTest();
    fs.writeFileSync(file, "{not json");
    expect(enableSystemEventPersistence(file)).toBe(0);
    enqueueSystemEvent("still works", { sessionKey: KEY });
    expect(restart()).toBe(1);
  });

  it("keeps its duplicate rule across a restart", () => {
    enableSystemEventPersistence(file);
    enqueueSystemEvent("same", { sessionKey: KEY });
    restart();
    enqueueSystemEvent("same", { sessionKey: KEY });
    expect(peekSystemEvents(KEY)).toEqual(["same"]);
  });

  it("saves nothing unless persistence was turned on", () => {
    enqueueSystemEvent("in memory only", { sessionKey: KEY });
    flushSystemEventPersistence();
    expect(fs.existsSync(file)).toBe(false);
  });
});
