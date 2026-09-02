/**
 * PLAN-43 §3.2b: the remote-caller tool floor. A remote A2A task turn gets
 * NO tools by default, operator grants can extend it, and the always-deny
 * floor (wallet/shell/sessions/egress) can never be granted back —
 * invariant I9's tool-layer half.
 */

import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { isA2aTaskSessionKey } from "../sessions/session-key-utils.js";
import { resolveA2aRemoteToolPolicy } from "./a2a-remote-policy.js";
import { isToolAllowedByPolicyName } from "./pi-tools.policy.js";

const FLOOR_SAMPLES = [
  "wallet",
  "exec",
  "process",
  "bash",
  "apply_patch",
  "gateway",
  "sessions_spawn",
  "sessions_send",
  "subagents",
  "cron",
  "nodes",
  "skill_manage",
  "browser",
  "computer_use",
  "message",
  "whatsapp_login",
  "web_search",
  "web_fetch",
  "code_interpreter",
  "memory_search",
  "dream_status",
  "a2a_client",
  "task_workspace_get",
];

describe("resolveA2aRemoteToolPolicy", () => {
  it("defaults to NO tools at all (empty allowlist fails closed)", () => {
    const policy = resolveA2aRemoteToolPolicy(undefined);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("session_status", policy)).toBe(false);
    for (const name of FLOOR_SAMPLES) {
      expect(isToolAllowedByPolicyName(name, policy), name).toBe(false);
    }
  });

  it("operator allow extends the toolset for non-floor tools", () => {
    const cfg = {
      a2a: { remoteExecution: { tools: { allow: ["read", "grep"] } } },
    } as unknown as BitterbotConfig;
    const policy = resolveA2aRemoteToolPolicy(cfg);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("grep", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(false);
  });

  it("the floor can NEVER be granted back, even by explicit allow (I9)", () => {
    const cfg = {
      a2a: {
        remoteExecution: {
          tools: { allow: ["*", ...FLOOR_SAMPLES] },
        },
      },
    } as unknown as BitterbotConfig;
    const policy = resolveA2aRemoteToolPolicy(cfg);
    for (const name of FLOOR_SAMPLES) {
      expect(isToolAllowedByPolicyName(name, policy), name).toBe(false);
    }
    // The wildcard does widen non-floor tools — that is the operator's call.
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
  });

  it("operator deny narrows further", () => {
    const cfg = {
      a2a: { remoteExecution: { tools: { allow: ["read"], deny: ["read"] } } },
    } as unknown as BitterbotConfig;
    expect(isToolAllowedByPolicyName("read", resolveA2aRemoteToolPolicy(cfg))).toBe(false);
  });
});

describe("isA2aTaskSessionKey", () => {
  it("matches only agent:<id>:a2a-task:* sessions", () => {
    expect(isA2aTaskSessionKey("agent:main:a2a-task:abc-123")).toBe(true);
    expect(isA2aTaskSessionKey("agent:default:a2a-task:abc")).toBe(true);
    expect(isA2aTaskSessionKey("agent:main:subagent:abc")).toBe(false);
    expect(isA2aTaskSessionKey("agent:main:cron:job:run:1")).toBe(false);
    expect(isA2aTaskSessionKey("agent:main:main")).toBe(false);
    expect(isA2aTaskSessionKey(undefined)).toBe(false);
    expect(isA2aTaskSessionKey("")).toBe(false);
  });
});
