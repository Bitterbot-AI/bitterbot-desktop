import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let dir: string;
afterEach(() => {
  vi.resetModules();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("guest sessions", () => {
  it("make a direct chat with a contact third-party for learning", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-guest-sessions-"));
    vi.doMock("../config/paths.js", async (orig) => ({
      ...(await orig<typeof import("../config/paths.js")>()),
      resolveStateDir: () => dir,
    }));
    const { markGuestSession, isGuestSession } = await import("./guest-sessions.js");
    const { classifySessionKeyTrust } = await import("./session-trust.js");
    const dm = "agent:main:telegram:dm:12345";

    expect(classifySessionKeyTrust(dm)).toBe("first_party");
    markGuestSession(dm);
    expect(isGuestSession(dm)).toBe(true);
    expect(classifySessionKeyTrust(dm)).toBe("untrusted");
    // The owner's own sessions are untouched.
    expect(classifySessionKeyTrust("agent:main:main")).toBe("first_party");
  });
});
