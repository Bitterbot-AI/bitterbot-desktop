import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";

// Redirect CONFIG_DIR to a temp dir so hash-state writes don't touch the user's profile.
let TMP: string;
vi.mock("../utils.js", async () => {
  const real = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...real,
    get CONFIG_DIR() {
      return TMP;
    },
  };
});

import {
  __resetHeartbeatHashStateForTest,
  commitHeartbeatHash,
  computeHeartbeatInputHash,
  evaluateHeartbeatHashGate,
  filterHeartbeatOnlyFiles,
  isHashGatedHeartbeatReason,
  loadLastHeartbeatHash,
  normalizeHeartbeatContent,
  resolveCheapHeartbeatModelSpec,
  resolveHeartbeatLightContext,
  resolveHeartbeatSkipWhenUnchanged,
} from "./heartbeat-gate.js";

beforeEach(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-hb-gate-"));
  __resetHeartbeatHashStateForTest();
});

afterEach(async () => {
  __resetHeartbeatHashStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("config defaults", () => {
  it("skipWhenUnchanged and lightContext default to true and can be turned off", () => {
    expect(resolveHeartbeatSkipWhenUnchanged(undefined)).toBe(true);
    expect(resolveHeartbeatSkipWhenUnchanged({ skipWhenUnchanged: false })).toBe(false);
    expect(resolveHeartbeatLightContext(undefined)).toBe(true);
    const cfg: BitterbotConfig = {
      agents: { defaults: { heartbeat: { lightContext: false } } },
    };
    expect(resolveHeartbeatLightContext(cfg, { agentId: "main" })).toBe(false);
  });

  it("lightContext honors the per-agent override, resolved from a session key", () => {
    const cfg: BitterbotConfig = {
      agents: {
        defaults: { heartbeat: { lightContext: false } },
        list: [
          { id: "main", default: true },
          { id: "ops", heartbeat: { lightContext: true } },
        ],
      },
    };
    expect(resolveHeartbeatLightContext(cfg, { sessionKey: "agent:ops:main:heartbeat" })).toBe(
      true,
    );
    expect(resolveHeartbeatLightContext(cfg, { sessionKey: "agent:main:main" })).toBe(false);
  });
});

describe("isHashGatedHeartbeatReason", () => {
  it("gates only schedule-driven ticks", () => {
    expect(isHashGatedHeartbeatReason(undefined)).toBe(true);
    expect(isHashGatedHeartbeatReason("interval")).toBe(true);
    expect(isHashGatedHeartbeatReason("cache-warm")).toBe(true);
    for (const reason of ["wake", "exec-event", "cron:job-1", "hook:github", "manual", "retry"]) {
      expect(isHashGatedHeartbeatReason(reason)).toBe(false);
    }
  });
});

describe("computeHeartbeatInputHash", () => {
  const base = {
    heartbeatContent: "# HB\n- check inbox\n",
    prompt: "Read HEARTBEAT.md",
    pendingEvents: [],
  };

  it("is stable across cosmetic edits (CRLF, trailing spaces, blank-line runs)", () => {
    const a = computeHeartbeatInputHash(base);
    const b = computeHeartbeatInputHash({
      ...base,
      heartbeatContent: "# HB  \r\n- check inbox   \r\n\r\n\r\n",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the file, the prompt, or the pending events change", () => {
    const a = computeHeartbeatInputHash(base);
    expect(
      computeHeartbeatInputHash({ ...base, heartbeatContent: "# HB\n- check calendar\n" }),
    ).not.toBe(a);
    expect(computeHeartbeatInputHash({ ...base, prompt: "Different prompt" })).not.toBe(a);
    expect(computeHeartbeatInputHash({ ...base, pendingEvents: ["Cron: reminder"] })).not.toBe(a);
  });

  it("distinguishes a missing file from an empty one", () => {
    expect(computeHeartbeatInputHash({ ...base, heartbeatContent: undefined })).not.toBe(
      computeHeartbeatInputHash({ ...base, heartbeatContent: "" }),
    );
  });

  it("normalizeHeartbeatContent returns '' for non-strings", () => {
    expect(normalizeHeartbeatContent(undefined)).toBe("");
    expect(normalizeHeartbeatContent(null)).toBe("");
  });
});

describe("hash state persistence", () => {
  it("round-trips through memory and disk, surviving an in-memory reset", async () => {
    expect(await loadLastHeartbeatHash("main")).toBeUndefined();
    await commitHeartbeatHash("main", "abc", 1234);
    expect(await loadLastHeartbeatHash("main")).toEqual({ hash: "abc", at: 1234 });
    const file = path.join(TMP, "heartbeat", "last-input-hash-main.json");
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({ hash: "abc", at: 1234 });
    // Simulate a process restart: memory gone, disk still there.
    __resetHeartbeatHashStateForTest();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ hash: "abc", at: 1234 }));
    expect(await loadLastHeartbeatHash("main")).toEqual({ hash: "abc", at: 1234 });
  });

  it("ignores a corrupt state file", async () => {
    const file = path.join(TMP, "heartbeat", "last-input-hash-main.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");
    expect(await loadLastHeartbeatHash("main")).toBeUndefined();
  });
});

describe("evaluateHeartbeatHashGate", () => {
  const input = { heartbeatContent: "- task", prompt: "p", pendingEvents: [] };

  it("returns no hash when the flag is off or the reason bypasses the gate", async () => {
    expect(
      await evaluateHeartbeatHashGate({
        agentId: "main",
        heartbeat: { skipWhenUnchanged: false },
        reason: "interval",
        input,
      }),
    ).toEqual({});
    expect(await evaluateHeartbeatHashGate({ agentId: "main", reason: "wake", input })).toEqual({});
  });

  it("reports unchanged only after a commit with the same inputs", async () => {
    const first = await evaluateHeartbeatHashGate({ agentId: "main", reason: "interval", input });
    expect(first.inputHash).toBeDefined();
    expect(first.unchanged).toBeUndefined();
    await commitHeartbeatHash("main", first.inputHash!, 10);
    const second = await evaluateHeartbeatHashGate({ agentId: "main", reason: "interval", input });
    expect(second.unchanged).toEqual({ hash: first.inputHash, at: 10 });
    const changed = await evaluateHeartbeatHashGate({
      agentId: "main",
      reason: "interval",
      input: { ...input, heartbeatContent: "- other task" },
    });
    expect(changed.unchanged).toBeUndefined();
    // Per-agent state: a different agent is not gated by main's commit.
    const other = await evaluateHeartbeatHashGate({ agentId: "ops", reason: "interval", input });
    expect(other.unchanged).toBeUndefined();
  });
});

describe("light context helpers", () => {
  it("filterHeartbeatOnlyFiles keeps only HEARTBEAT.md", () => {
    const files = [
      { path: "/ws/GENOME.md", content: "g" },
      { path: "/ws/HEARTBEAT.md", content: "h" },
      { path: "/ws/PROTOCOLS.md", content: "p" },
    ];
    expect(filterHeartbeatOnlyFiles(files)).toEqual([{ path: "/ws/HEARTBEAT.md", content: "h" }]);
  });

  it("resolveCheapHeartbeatModelSpec mirrors the memory-lane env rule with a safe fallback", () => {
    expect(resolveCheapHeartbeatModelSpec({ ANTHROPIC_API_KEY: "sk-ant" })).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(resolveCheapHeartbeatModelSpec({ OPENAI_API_KEY: "sk" })).toBe("openai/gpt-4o-mini");
    expect(
      resolveCheapHeartbeatModelSpec({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk" }),
    ).toBe("anthropic/claude-haiku-4-5");
    expect(resolveCheapHeartbeatModelSpec({})).toBeUndefined();
    expect(resolveCheapHeartbeatModelSpec({ ANTHROPIC_API_KEY: "   " })).toBeUndefined();
  });
});
