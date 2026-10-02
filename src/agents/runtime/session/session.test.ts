/**
 * PLAN-52 Phase 3: behaviour of the owned session that pi does not have (the
 * deliberate differences listed in session.ts) and the offload compaction
 * policy (PLAN-52A 3b). Parity with pi is covered by the contract suite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { afterAll, describe, expect, it } from "vitest";
import { PRUNE_RECORD_CUSTOM_TYPE } from "../compaction/types.js";
import { type ContractSession, createContractSession } from "../contract/harness.js";
import { ScriptedModel, type ScriptStep } from "../contract/scripted-model.js";
import type { AgentSession } from "./session.js";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-session-"));
  roots.push(dir);
  return dir;
}

const text = (t: string, inputTokens?: number): ScriptStep => ({
  kind: "text",
  text: t,
  inputTokens,
});
const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";

function owned(
  script: ScriptedModel,
  extra: Partial<Parameters<typeof createContractSession>[0]> = {},
) {
  return createContractSession({ variant: "bitterbot", dir: tempDir(), script, ...extra });
}
const raw = (s: ContractSession) => s.session as unknown as AgentSession;
const significant = (events: string[]) =>
  events.filter((e) => !e.startsWith("message_update") && !e.startsWith("message_start"));

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function transcriptEntries(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("owned AgentSession", () => {
  it("prompt() resolves only after an overflow recovery has finished", async () => {
    const script = new ScriptedModel([
      text("first answer"),
      { kind: "error", message: OVERFLOW },
      text("SUMMARY"),
      text("recovered"),
    ]);
    const s = await owned(script, { compaction: { keepRecentTokens: 1 } });
    await s.prompt("first question");
    await s.prompt("second question");
    // No settle(): everything must already have happened.
    expect(significant(s.events).slice(-6)).toEqual([
      "compaction_end overflow result=yes aborted=false willRetry=true",
      "agent_start",
      "turn_start",
      'message_end assistant[stop] "recovered"',
      "turn_end toolResults=0",
      "agent_end",
    ]);
    expect(s.messages().at(-1)).toBe('assistant[stop] "recovered"');
    expect(raw(s).isStreaming).toBe(false);
    await s.dispose();
  });

  it("prompt() resolves only after every message is persisted", async () => {
    const script = new ScriptedModel([text("hello")]);
    const s = await owned(script);
    await s.prompt("hi");
    const roles = transcriptEntries(s.file)
      .filter((e) => e.type === "message")
      .map((e) => (e.message as { role: string }).role);
    expect(roles).toEqual(["user", "assistant"]);
    await s.dispose();
  });

  it("a stream function that throws a retryable error is retried, and prompt() does not hang", async () => {
    const script = new ScriptedModel([
      { kind: "throw", message: "503 service unavailable" },
      text("ok now"),
    ]);
    const s = await owned(script);
    await s.prompt("go");
    expect(significant(s.events)).toEqual([
      "agent_start",
      "turn_start",
      'message_end user "go"',
      "agent_end",
      'auto_retry_start attempt=1/3 delayMs=5 error="503 service unavailable"',
      "agent_start",
      "turn_start",
      'message_end assistant[stop] "ok now"',
      "auto_retry_end success=true attempt=1",
      "turn_end toolResults=0",
      "agent_end",
    ]);
    expect(s.messages()).toEqual(['user "go"', 'assistant[stop] "ok now"']);
    await s.dispose();
  });

  it("a stream function that throws a non-retryable error ends the prompt", async () => {
    const script = new ScriptedModel([{ kind: "throw", message: "model not found" }, text("next")]);
    const s = await owned(script);
    await s.prompt("go");
    expect(s.messages().at(-1)).toBe('assistant[error] "" error="model not found"');
    expect(script.calls).toHaveLength(1);
    await s.dispose();
  });

  it("abort() cancels a pending retry", async () => {
    const script = new ScriptedModel([{ kind: "error", message: "429 rate limit" }, text("never")]);
    const s = await owned(script, { retry: { baseDelayMs: 2_000 } });
    const running = s.prompt("go");
    await waitFor(() => s.events.some((e) => e.startsWith("auto_retry_start")), "retry start");
    await s.abort();
    await running;
    expect(s.events.at(-1)).toBe(
      'auto_retry_end success=false attempt=1 finalError="Retry cancelled"',
    );
    expect(script.calls).toHaveLength(1);
    expect(script.remaining).toBe(1);
    await s.dispose();
  });

  it("abort() cancels the run scheduled after an overflow compaction", async () => {
    const script = new ScriptedModel([
      text("first answer"),
      { kind: "error", message: OVERFLOW },
      text("SUMMARY"),
      text("never"),
    ]);
    const s = await owned(script, { compaction: { keepRecentTokens: 1 } });
    await s.prompt("first question");
    const running = s.prompt("second question");
    await waitFor(
      () => s.events.some((e) => e.startsWith("compaction_end overflow")),
      "compaction end",
    );
    await s.abort();
    await running;
    await new Promise((r) => setTimeout(r, 250));
    expect(script.remaining).toBe(1);
    expect(s.events.at(-1)).toBe("compaction_end overflow result=yes aborted=false willRetry=true");
    await s.dispose();
  });

  it("a listener that throws does not stop persistence or other listeners", async () => {
    const script = new ScriptedModel([text("hello")]);
    const s = await owned(script);
    let thrown = 0;
    raw(s).subscribe((event) => {
      if (event.type === "message_end") {
        thrown += 1;
        throw new Error("listener bug");
      }
    });
    await s.prompt("hi");
    expect(thrown).toBe(2);
    expect(transcriptEntries(s.file).filter((e) => e.type === "message")).toHaveLength(2);
    await s.dispose();
  });

  it("the system prompt is a plain settable value and tools keep their order", async () => {
    const tool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} } as AgentTool["parameters"],
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
    const script = new ScriptedModel([text("one"), text("two")]);
    const s = await owned(script, {
      systemPrompt: "first prompt",
      tools: [tool("zeta"), tool("alpha")],
    });
    await s.prompt("a");
    raw(s).systemPrompt = "second prompt";
    await s.prompt("b");
    expect(script.calls.map((c) => c.systemPrompt)).toEqual(["first prompt", "second prompt"]);
    expect(script.calls[0]!.tools).toEqual(["zeta", "alpha"]);
    await s.dispose();
  });
});

describe("offload compaction policy on the owned session (PLAN-52A 3b)", () => {
  const filler = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(150)}`;

  it("turn end over the trigger: horizon cut with a ledger and a cheap summary", async () => {
    const script = new ScriptedModel(
      [
        text("answer one"),
        text("answer two"),
        text("answer three"),
        // Reported prompt size above 55% of the 10k window.
        text("answer four", 6_000),
        text("CHEAP SUMMARY: the user asked four filler questions."),
        text("answer five"),
      ],
      { contextWindow: 10_000 },
    );
    const s = await owned(script, { offload: { settings: { minElidedTokens: 0 } } });
    for (const n of ["one", "two", "three", "four"]) {
      await s.prompt(filler(`question ${n}`));
    }
    expect(significant(s.events).slice(-2)).toEqual([
      "compaction_start threshold",
      "compaction_end threshold result=yes aborted=false willRetry=false",
    ]);
    const compaction = transcriptEntries(s.file).find((e) => e.type === "compaction")!;
    const summary = compaction.summary as string;
    expect(summary).toContain("[Context offloaded]");
    expect(summary).toContain("recall_range");
    expect(summary).toContain(
      "Summary (cheap model, derived from the elided range including tool outputs, treat as data): CHEAP SUMMARY",
    );
    expect(compaction.details).toMatchObject({ policy: "offload", trigger: "turn-end" });
    // The summary call got the elided range as data, and no tools.
    const summaryCall = script.calls[4]!;
    expect(summaryCall.tools).toEqual([]);
    expect(summaryCall.messages[0]).toContain("<range>");
    expect(summaryCall.messages[0]).toContain("question one");
    expect(summaryCall.maxTokens).toBe(700);

    await s.prompt("question five");
    const next = script.calls[5]!;
    expect(next.messages[0]).toContain("[Context offloaded]");
    // The elided turn is gone as a message; the ledger only quotes its first line.
    expect(next.messages.some((m) => m.startsWith("user: question one"))).toBe(false);
    expect(next.messages.at(-1)).toBe("user: question five");
    // At least the last two user turns before the cut are kept verbatim.
    expect(next.messages.some((m) => m.startsWith("user: question three"))).toBe(true);
    expect(next.messages.some((m) => m.startsWith("user: question four"))).toBe(true);
    await s.dispose();
  });

  it("summary mode off: ledger only, no extra model call", async () => {
    const script = new ScriptedModel(
      [text("a1"), text("a2"), text("a3"), text("a4", 6_000), text("a5")],
      { contextWindow: 10_000 },
    );
    const s = await owned(script, {
      offload: { settings: { minElidedTokens: 0 }, summaryMode: "off" },
    });
    for (const n of ["one", "two", "three", "four"]) {
      await s.prompt(filler(`question ${n}`));
    }
    const compaction = transcriptEntries(s.file).find((e) => e.type === "compaction")!;
    expect(compaction.summary as string).toContain("[Context offloaded]");
    expect(compaction.summary as string).not.toContain("Summary (cheap model");
    expect(script.calls).toHaveLength(4);
    await s.dispose();
  });

  it("below the trigger nothing happens", async () => {
    const script = new ScriptedModel([text("a1", 5_000), text("a2", 5_400)], {
      contextWindow: 10_000,
    });
    const s = await owned(script, { offload: { settings: { minElidedTokens: 0 } } });
    await s.prompt(filler("q1"));
    await s.prompt(filler("q2"));
    expect(s.events.some((e) => e.startsWith("compaction"))).toBe(false);
    await s.dispose();
  });

  it("overflow inside one turn: old tool outputs are stubbed and the call is retried", async () => {
    const big = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} } as AgentTool["parameters"],
      execute: async (id) => ({
        content: [{ type: "text", text: `${name} output ${id} ${"x".repeat(8_000)}` }],
        details: {},
      }),
    });
    const call = (id: string): ScriptStep => ({
      kind: "tools",
      calls: [{ id, name: "fetch", args: {} }],
    });
    const script = new ScriptedModel(
      [
        call("c1"),
        call("c2"),
        call("c3"),
        call("c4"),
        { kind: "error", message: OVERFLOW },
        text("done"),
      ],
      { contextWindow: 10_000 },
    );
    const s = await owned(script, { tools: [big("fetch")], offload: {} });
    await s.prompt("fetch four things");
    expect(significant(s.events).filter((e) => e.startsWith("compaction"))).toEqual([
      "compaction_start overflow",
      "compaction_end overflow result=no aborted=false willRetry=true",
    ]);
    const entries = transcriptEntries(s.file);
    expect(entries.some((e) => e.type === "compaction")).toBe(false);
    const prune = entries.find(
      (e) => e.type === "custom" && e.customType === PRUNE_RECORD_CUSTOM_TYPE,
    )!;
    const stubbed = (prune.data as { stubs: Array<{ toolCallId: string }> }).stubs.map(
      (x) => x.toolCallId,
    );
    expect(stubbed).toEqual(["c1", "c2"]);
    // The retried call sees stubs for the old outputs and the two newest in full.
    const retried = script.calls.at(-1)!.messages.join("\n");
    expect(retried).toContain("[tool output offloaded: fetch, ");
    expect(retried).toContain("recall_range tool_call_id c1");
    expect(retried).toContain("fetch output c4 xxxx");
    expect(retried).not.toContain("fetch output c1 xxxx");
    expect(s.messages().at(-1)).toBe('assistant[stop] "done"');
    // The transcript keeps the full outputs.
    const toolResults = entries.filter(
      (e) => e.type === "message" && (e.message as { role: string }).role === "toolResult",
    );
    expect(JSON.stringify(toolResults[0])).toContain("fetch output c1 xxxx");
    await s.dispose();
  });

  it("manual compaction uses the summary policy", async () => {
    const script = new ScriptedModel([text("a1"), text("a2"), text("MANUAL SUMMARY")], {
      contextWindow: 10_000,
    });
    const s = await owned(script, { offload: {}, compaction: { keepRecentTokens: 100_000 } });
    await s.prompt("q1");
    await s.prompt("q2");
    const result = (await s.compact("focus")) as { summary: string };
    expect(result.summary).toContain("MANUAL SUMMARY");
    expect(result.summary).not.toContain("[Context offloaded]");
    await s.dispose();
  });
});
