import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  isIsolatedHeartbeatSessionKey,
  resetIsolatedHeartbeatSession,
  resolveIsolatedHeartbeatSessionKey,
  shouldRunHeartbeatIsolated,
} from "./heartbeat-session.js";

describe("isolated heartbeat session key", () => {
  it("derives `<base>:heartbeat` and recognizes it", () => {
    const key = resolveIsolatedHeartbeatSessionKey("agent:main:main");
    expect(key).toBe("agent:main:main:heartbeat");
    expect(isIsolatedHeartbeatSessionKey(key)).toBe(true);
    expect(isIsolatedHeartbeatSessionKey("agent:main:main")).toBe(false);
    expect(isIsolatedHeartbeatSessionKey("global")).toBe(false);
  });

  it("isolates only schedule ticks with nothing queued, on agent-scoped keys, without an explicit session", () => {
    const base = { baseSessionKey: "agent:main:main", pendingEventCount: 0 };
    expect(shouldRunHeartbeatIsolated(base)).toBe(true);
    expect(shouldRunHeartbeatIsolated({ ...base, heartbeat: { isolatedSession: false } })).toBe(
      false,
    );
    expect(shouldRunHeartbeatIsolated({ ...base, pendingEventCount: 1 })).toBe(false);
    expect(shouldRunHeartbeatIsolated({ ...base, baseSessionKey: "global" })).toBe(false);
    expect(shouldRunHeartbeatIsolated({ ...base, explicitSession: true })).toBe(false);
  });
});

describe("resetIsolatedHeartbeatSession", () => {
  it("drops the isolated entry and its transcript, leaving the main entry alone", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-hb-session-"));
    try {
      const storePath = path.join(tmp, "sessions.json");
      const transcript = path.join(tmp, "hb-sid.jsonl");
      await fs.writeFile(transcript, "{}\n");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "main-sid", updatedAt: 1 },
          "agent:main:main:heartbeat": {
            sessionId: "hb-sid",
            sessionFile: transcript,
            updatedAt: 2,
          },
        }),
      );
      await resetIsolatedHeartbeatSession({
        storePath,
        sessionKey: "agent:main:main:heartbeat",
        agentId: "main",
      });
      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.sessionId).toBe("main-sid");
      expect(store["agent:main:main:heartbeat"]).toBeUndefined();
      await expect(fs.access(transcript)).rejects.toThrow();
      // Idempotent when nothing is there.
      await resetIsolatedHeartbeatSession({
        storePath,
        sessionKey: "agent:main:main:heartbeat",
        agentId: "main",
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
