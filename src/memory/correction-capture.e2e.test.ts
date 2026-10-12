/**
 * PLAN-55 Phase 1 end-to-end: "teach it once".
 *
 * Boots the REAL MemoryIndexManager (same harness as canonical-facts.e2e),
 * drives the real run-completion hook (runCorrectionCaptureAfterTurn) with
 * an owner turn whose correction is extracted by an injected cheap model,
 * then resolves the canonical block the way every runner does on a cold
 * session and asserts the new value is there, at owner tier, with the
 * session line as evidence. The same hook with a heartbeat, a guest, a
 * subagent session or session.memory = "off" makes no model call.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async () => [],
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

import { resolveCanonicalFactsBlock } from "../agents/canonical-facts-block.js";
import { createMemoryPinTool } from "../agents/tools/memory-tool.js";
import { runCorrectionCaptureAfterTurn } from "../auto-reply/reply/agent-runner-memory.js";
import type { FollowupRun } from "../auto-reply/reply/queue.js";
import type { CanonicalFactsStore } from "./canonical-facts.js";
import { getMemorySearchManager } from "./index.js";

const SESSION_KEY = "agent:main:main";
let fixtureRoot: string;
let sessionFile: string;
let cfg: Record<string, unknown>;
const llm = vi.fn(async (_prompt: string) => "{}");

function followupRun(over: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "x",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: path.join(fixtureRoot, "agent"),
      sessionId: "s1",
      sessionKey: SESSION_KEY,
      senderIsOwner: true,
      sessionFile,
      workspaceDir: path.join(fixtureRoot, "acme"),
      config: cfg as never,
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1000,
      blockReplyBreak: "message_end",
      ...over,
    },
  } as unknown as FollowupRun;
}

async function writeTranscript(lines: Array<{ role: "user" | "assistant"; text: string }>) {
  await fs.writeFile(
    sessionFile,
    lines
      .map((l) => JSON.stringify({ type: "message", message: { role: l.role, content: l.text } }))
      .join("\n") + "\n",
    "utf8",
  );
}

async function store(): Promise<CanonicalFactsStore> {
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
  return (manager as unknown as { canonicalFacts(): CanonicalFactsStore }).canonicalFacts();
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-correction-e2e-"));
  const workspaceDir = path.join(fixtureRoot, "acme");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "sessions"), { recursive: true });
  sessionFile = path.join(fixtureRoot, "sessions", "s1.jsonl");
  cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: path.join(fixtureRoot, "index.sqlite"), vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
    // The injected dream llmCall is reused by the correction lane.
    memory: { dream: { llmCall: llm, minChunksForDream: 1_000_000 } },
  };
});

afterAll(async () => {
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
  await manager?.close?.();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  llm.mockReset();
});

describe("correction capture end-to-end (real manager, real hook, real resolver)", () => {
  it("an owner correction is in the ledger before the next turn and renders on a cold session", async () => {
    const s = await store();
    s.pin({ key: "infra.deploy_endpoint", value: "api.acme.com", source: "extraction" });
    await writeTranscript([
      { role: "user", text: "hi" },
      { role: "assistant", text: "Deploys go to api.acme.com." },
      { role: "user", text: "No, the deploy endpoint is api2.acme.com" },
      { role: "assistant", text: "Noted: api2.acme.com." },
    ]);
    llm.mockResolvedValueOnce(
      JSON.stringify({
        facts: [
          {
            key: "infra.deploy_endpoint",
            value: "api2.acme.com",
            statement: "The deploy endpoint is api2.acme.com.",
            correction: true,
            scope: "global",
          },
        ],
      }),
    );
    const line = await runCorrectionCaptureAfterTurn({
      cfg: cfg as never,
      followupRun: followupRun(),
      sessionKey: SESSION_KEY,
      commandBody: "No, the deploy endpoint is api2.acme.com",
      replyText: "Noted: api2.acme.com.",
      isHeartbeat: false,
      chatType: "direct",
      runStartedAt: Date.now() - 10,
    });
    expect(llm).toHaveBeenCalledTimes(1);
    const prompt = llm.mock.calls[0]![0];
    expect(prompt).toContain("correction pass");
    expect(prompt).toContain('The current project is "acme"');
    expect(line).toBe("Memory updated: deploy endpoint = api2.acme.com (was api.acme.com)");

    const fact = s.get("infra.deploy_endpoint");
    expect(fact).toMatchObject({
      value: "api2.acme.com",
      source: "owner",
      scope: "global",
      evidenceRef: `session:${sessionFile}#L3`,
    });

    // Cold session: no message, no embedding, the block carries the new value
    // and not the old one.
    const block = await resolveCanonicalFactsBlock({ config: cfg as never, agentId: "main" });
    expect(block).toContain("[infra.deploy_endpoint] api2.acme.com");
    expect(block).not.toContain("api.acme.com\n");
    expect(block).not.toMatch(/\] api\.acme\.com/);

    // The agent cannot talk it back down.
    expect(
      s.pin({ key: "infra.deploy_endpoint", value: "api.acme.com", source: "agent_pin" }).op,
    ).toBe("held");
  });

  it("heartbeat, guest, subagent and incognito turns make no model call", async () => {
    const base = {
      cfg: cfg as never,
      sessionKey: SESSION_KEY,
      commandBody: "No, the deploy endpoint is api3.acme.com",
      replyText: "ok",
      isHeartbeat: false,
      chatType: "direct",
      runStartedAt: Date.now(),
    };
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        followupRun: followupRun(),
        isHeartbeat: true,
      }),
    ).toBeNull();
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        followupRun: followupRun({ senderIsOwner: false }),
      }),
    ).toBeNull();
    const subKey = "agent:main:subagent:abc";
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        sessionKey: subKey,
        followupRun: followupRun({ sessionKey: subKey }),
      }),
    ).toBeNull();
    const incognito = { ...(cfg as object), session: { memory: "off" } } as never;
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        cfg: incognito,
        followupRun: followupRun({ config: incognito }),
      }),
    ).toBeNull();
    expect(llm).not.toHaveBeenCalled();
    expect((await store()).get("infra.deploy_endpoint")?.value).toBe("api2.acme.com");
  });

  it("the model path: memory_pin carries evidence and scope, and a held supersede reaches the line", async () => {
    const tool = createMemoryPinTool({ config: cfg as never })!;
    const runStartedAt = Date.now() - 5;
    const added = await tool.execute("pin1", {
      action: "pin",
      key: "preference.editor",
      value: "vim",
      evidence: "I prefer vim",
      scope: "person:victor",
    });
    expect((added.details as { ok: boolean; op: string }).op).toBe("add");
    const held = await tool.execute("pin2", {
      action: "pin",
      key: "infra.deploy_endpoint",
      value: "api9.acme.com",
      evidence: "trust me",
    });
    expect(held.details).toMatchObject({
      ok: false,
      held: true,
      current: { value: "api2.acme.com", source: "owner" },
      proposedValue: "api9.acme.com",
    });
    const s = await store();
    expect(s.get("preference.editor")).toMatchObject({
      scope: "person:victor",
      evidenceRef: "I prefer vim",
      source: "agent_pin",
    });
    expect(s.get("infra.deploy_endpoint")?.value).toBe("api2.acme.com");

    // A turn with no corrective shape: no call, but the line still reports
    // what the agent did and what was held.
    const line = await runCorrectionCaptureAfterTurn({
      cfg: cfg as never,
      followupRun: followupRun(),
      sessionKey: SESSION_KEY,
      commandBody: "thanks",
      replyText: "ok",
      isHeartbeat: false,
      chatType: "direct",
      runStartedAt,
    });
    expect(llm).not.toHaveBeenCalled();
    expect(line).toBe(
      "Memory updated: editor = vim (for victor); held for your confirmation: deploy endpoint api2.acme.com -> api9.acme.com",
    );
  });
});
