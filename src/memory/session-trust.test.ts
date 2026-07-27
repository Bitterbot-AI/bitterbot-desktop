/**
 * PLAN-34 review finding M2 (hotfixed against PLAN-33 Phase 2): structured
 * ground-truth writes must only derive from first-party sessions. These tests
 * pin the classifier and the fail-closed resolver.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let fixtureDir: string;

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => fixtureDir,
}));

import { buildSessionTrustResolver, classifySessionKeyTrust } from "./session-trust.js";

describe("classifySessionKeyTrust", () => {
  it("treats owner chat sessions as first-party", () => {
    expect(classifySessionKeyTrust("agent:main:main")).toBe("first_party");
    expect(classifySessionKeyTrust("agent:main:chat-1783705394205-al1gyj")).toBe("first_party");
    expect(classifySessionKeyTrust("agent:main:telegram:dm:u123")).toBe("first_party");
    expect(classifySessionKeyTrust("agent:main")).toBe("first_party");
    expect(classifySessionKeyTrust("agent:main:cron:job-42")).toBe("first_party");
  });

  it("treats third-party-content sessions as untrusted", () => {
    expect(classifySessionKeyTrust("agent:default:a2a-task:631aac75")).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main:discord:group:g99")).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main:telegram:channel:c1")).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main:circles:mailbox:abc")).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main:subagent:xyz")).toBe("untrusted");
    // PLAN-38 §4.1 T9: canvas/sandbox sessions carry peer card text and other
    // members' agent moves. These classified first_party before 2026-07-27 —
    // the prefix guard below deliberately does not match "canvas", so the
    // tokens must be listed explicitly. Regressing this re-opens a path from
    // peer content to canonical pins and standing directives.
    expect(classifySessionKeyTrust("agent:main:canvas:card-1")).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main:sandbox:card-1:round-2")).toBe("untrusted");
  });

  it("fails closed on malformed keys", () => {
    expect(classifySessionKeyTrust("not-a-session-key")).toBe("unknown");
    expect(classifySessionKeyTrust("")).toBe("unknown");
  });
});

describe("buildSessionTrustResolver", () => {
  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-session-trust-"));
    await fs.writeFile(
      path.join(fixtureDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "aaaa-1111" },
        "agent:main:discord:group:g99": { sessionId: "bbbb-2222" },
        "agent:default:a2a-task:x": { sessionId: "cccc-3333" },
        "agent:main:broken": {},
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("maps transcript files to their session key's trust", async () => {
    const trust = await buildSessionTrustResolver("main");
    expect(trust(path.join(fixtureDir, "aaaa-1111.jsonl"))).toBe("first_party");
    expect(trust(path.join(fixtureDir, "bbbb-2222.jsonl"))).toBe("untrusted");
    expect(trust(path.join(fixtureDir, "cccc-3333.jsonl"))).toBe("untrusted");
  });

  it("fails closed for unmapped files and missing stores", async () => {
    const trust = await buildSessionTrustResolver("main");
    expect(trust(path.join(fixtureDir, "never-seen.jsonl"))).toBe("unknown");

    fixtureDir = path.join(fixtureDir, "does-not-exist");
    const trustMissing = await buildSessionTrustResolver("main");
    expect(trustMissing("anything.jsonl")).toBe("unknown");
  });
});
