/**
 * PLAN-43 Phase 3 (3b adversarial): a skill-evolution validation session
 * carries PEER-authored skill text. Its key is recognizable everywhere it
 * matters: trust classification (no canonical pins/directives), transcript
 * ingestion (excluded), and the tool floor (remote-caller policy).
 */

import { describe, expect, it } from "vitest";
import { resolveA2aRemoteToolPolicy } from "../agents/a2a-remote-policy.js";
import { classifySessionKeyTrust } from "../memory/session-trust.js";
import {
  isSkillEvolveValidationSessionKey,
  makeSkillEvolveValidationSessionKey,
} from "./session-key-utils.js";

describe("skill-evolve validation session keys", () => {
  it("round-trips the marker and classifies as untrusted", () => {
    const key = makeSkillEvolveValidationSessionKey("main", "abcd1234");
    expect(key).toBe("agent:main:skill-evolve-val-abcd1234");
    expect(isSkillEvolveValidationSessionKey(key)).toBe(true);
    expect(isSkillEvolveValidationSessionKey("agent:main")).toBe(false);
    expect(isSkillEvolveValidationSessionKey("agent:main:cron:skill-evolve")).toBe(false);
    expect(isSkillEvolveValidationSessionKey(undefined)).toBe(false);
    expect(classifySessionKeyTrust(key)).toBe("untrusted");
    expect(classifySessionKeyTrust("agent:main")).toBe("first_party");
  });

  it("the remote floor that applies to these sessions denies money, shell, sessions, and egress", () => {
    const policy = resolveA2aRemoteToolPolicy(undefined);
    expect(policy.allow).toEqual([]);
    for (const denied of ["wallet", "shell", "sessions_*", "message", "web_fetch", "memory_*"]) {
      expect(policy.deny).toContain(denied);
    }
  });
});

describe("peer validation flavor (PLAN-44 Phase 2)", () => {
  it("is a validation key AND a peer key; the plain flavor is not peer", async () => {
    const {
      isSkillEvolvePeerValidationSessionKey,
      makeSkillEvolveValidationSessionKey,
      isSkillEvolveValidationSessionKey,
    } = await import("./session-key-utils.js");
    const peer = makeSkillEvolveValidationSessionKey("main", "abc", { peer: true });
    const plain = makeSkillEvolveValidationSessionKey("main", "abc");
    expect(peer).toBe("agent:main:skill-evolve-val-peer-abc");
    expect(isSkillEvolveValidationSessionKey(peer)).toBe(true);
    expect(isSkillEvolvePeerValidationSessionKey(peer)).toBe(true);
    expect(isSkillEvolvePeerValidationSessionKey(plain)).toBe(false);
  });
});
