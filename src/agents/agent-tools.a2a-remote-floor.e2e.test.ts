/**
 * PLAN-43 §3.2b end-to-end: through the REAL tool assembly, an inbound A2A
 * task session (a remote caller's turn) gets NO tools by default, and even
 * a maximally permissive operator grant cannot hand back the floor
 * (wallet/shell/sessions/egress). This is invariant I9 at the only seam
 * that matters — the toolset actually given to the spawned agent.
 */

import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import { createBitterbotCodingTools } from "./agent-tools.js";
import {
  SKILL_VALIDATION_SHELL_TOOLS,
  SKILL_VALIDATION_TOOL_ALLOW,
} from "./skill-validation-policy.js";

const A2A_SESSION_KEY = "agent:main:a2a-task:00000000-0000-0000-0000-000000000000";

describe("a2a remote floor (e2e through createBitterbotCodingTools)", () => {
  it("an a2a-task session gets ZERO tools by default", () => {
    const tools = createBitterbotCodingTools({ sessionKey: A2A_SESSION_KEY });
    expect(tools.map((t) => t.name)).toEqual([]);
  });

  // What a validation session may hold: the workspace-scoped file tools, the
  // confined shell (PLAN-45 D-2: on by default), and the hot-set meta-tools,
  // which only ever dispatch over this same filtered list.
  const VALIDATION_REACHABLE = new Set<string>([
    ...SKILL_VALIDATION_TOOL_ALLOW,
    ...SKILL_VALIDATION_SHELL_TOOLS,
    "list_tools",
    "use_tool",
  ]);
  const VALIDATION_FORBIDDEN = [
    "web_fetch",
    "web_search",
    "message",
    "skill_manage",
    "wallet",
    "circles",
    "browser",
  ];

  it("a skill-evolution validation session gets ONLY workspace-scoped file tools + the confined shell by default (PLAN-44 D-4, PLAN-45 D-2)", () => {
    const tools = createBitterbotCodingTools({
      sessionKey: "agent:main:skill-evolve-val-deadbeef",
    });
    const names = tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(VALIDATION_REACHABLE.has(name), `unclassified tool in validation: ${name}`).toBe(true);
    }
    expect(names).toContain("read");
    expect(names).toContain("exec");
    for (const forbidden of VALIDATION_FORBIDDEN) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("skills.evolution.validationTools.exec: false removes the shell and nothing else (adversarial C1)", () => {
    const tools = createBitterbotCodingTools({
      sessionKey: "agent:main:skill-evolve-val-deadbeef",
      config: { skills: { evolution: { validationTools: { exec: false } } } } as BitterbotConfig,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    for (const shell of SKILL_VALIDATION_SHELL_TOOLS) {
      expect(names).not.toContain(shell);
    }
    for (const forbidden of VALIDATION_FORBIDDEN) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("the PEER validation flavor (attestation sweep) keeps the no-tools floor", () => {
    const tools = createBitterbotCodingTools({
      sessionKey: "agent:main:skill-evolve-val-peer-deadbeef",
      config: { skills: { evolution: { validationTools: { exec: true } } } } as BitterbotConfig,
    });
    expect(tools.map((t) => t.name)).toEqual([]);
  });

  it("a normal session with the same config keeps its tools (the floor is scoped)", () => {
    const tools = createBitterbotCodingTools({ sessionKey: "agent:main:main" });
    expect(tools.length).toBeGreaterThan(0);
  });

  it("operator '*' grants ONLY the explicitly-classified-safe tools (subset pin)", () => {
    // Every tool surviving the floor under a wildcard grant must be in this
    // list. A NEW tool appearing here is a failure by design: it must be
    // consciously classified (extend the floor, or add it here) before a
    // remote caller can ever hold it. (The earlier version of this test
    // asserted selected absences, which stayed green when unlisted tools
    // leaked — the adversarial pass caught memory/skill/artifact tools
    // slipping through exactly that gap.)
    // The pi-coding base tools, all workspace-scoped. (Web/image/plugin
    // tools are stubbed out in this harness; web and image are floor-denied
    // by name regardless. Plugin tools are outside the floor's claim — an
    // operator who wildcards grants their own plugins knowingly.)
    // list_tools/use_tool are the hot-set meta-tools. They are classified safe
    // here because they operate over the registry AFTER the floor has filtered
    // it (applyHotSetExposure is the last step in createBitterbotCodingTools):
    // use_tool can only dispatch to a tool this same list already contains.
    const EXPECTED_SAFE = new Set([
      "read",
      "edit",
      "write",
      "complete",
      "plan",
      "list_tools",
      "use_tool",
    ]);
    const config = {
      a2a: { remoteExecution: { tools: { allow: ["*"] } } },
    } as unknown as BitterbotConfig;
    const tools = createBitterbotCodingTools({ sessionKey: A2A_SESSION_KEY, config });
    const names = tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(EXPECTED_SAFE.has(name), `unclassified tool reachable by remote caller: ${name}`).toBe(
        true,
      );
    }
  });

  it("a scoped operator allow grants exactly the non-floor tools named", () => {
    const config = {
      a2a: { remoteExecution: { tools: { allow: ["read", "wallet", "exec"] } } },
    } as unknown as BitterbotConfig;
    const tools = createBitterbotCodingTools({ sessionKey: A2A_SESSION_KEY, config });
    expect(tools.map((t) => t.name)).toEqual(["read"]);
  });
});
