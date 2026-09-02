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
import { createBitterbotCodingTools } from "./pi-tools.js";

const A2A_SESSION_KEY = "agent:main:a2a-task:00000000-0000-0000-0000-000000000000";

describe("a2a remote floor (e2e through createBitterbotCodingTools)", () => {
  it("an a2a-task session gets ZERO tools by default", () => {
    const tools = createBitterbotCodingTools({ sessionKey: A2A_SESSION_KEY });
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
    const EXPECTED_SAFE = new Set(["read", "edit", "write", "complete", "plan"]);
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
