/**
 * PLAN-52 Phase 3: tests of the owned summary compaction that do not need
 * pi-coding-agent. `summary.differential.test.ts` compares the same code with
 * pi and goes away with that dependency; this file stays.
 *
 * The prompt goldens in `__snapshots__` are the exact text sent to the model.
 * They were recorded while the differential tests were green, so they equal
 * what pi 0.73.1 sends. A change to them changes what the model is asked.
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { ScriptedModel } from "../../contract/scripted-model.js";
import { buildSessionContext } from "../../transcript/context.js";
import { TranscriptStore } from "../../transcript/store.js";
import {
  calculateContextTokens,
  compact,
  type CompactionSettings,
  type CompleteFn,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary,
  generateTurnPrefixSummary,
  getLastAssistantUsage,
  prepareCompaction,
  serializeConversation,
  type SessionMessage,
  shouldCompact,
  toSessionMessage,
} from "./index.js";
import {
  image,
  SCENARIOS,
  text,
  textOfTokens,
  thinking,
  toolCall,
  TranscriptBuilder,
  usage,
} from "./test-fixtures.js";

const MODEL: Model<Api> = {
  id: "fake",
  name: "fake",
  api: "fake-api",
  provider: "fake",
  baseUrl: "https://fake.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
};

type Call = { model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined };

function reply(textValue: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: textValue }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: usage(1, 1),
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  };
}

/** An injected model call that records requests and answers from a list. */
function fakeComplete(replies: AssistantMessage[]): { complete: CompleteFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const complete: CompleteFn = async (model, context, options) => {
    calls.push({ model, context, options });
    const next = queue.shift();
    if (!next) {
      throw new Error("fakeComplete: no reply left");
    }
    return next;
  };
  return { complete, calls };
}

function promptText(call: Call): string {
  const message = call.context.messages[0];
  if (message.role !== "user" || typeof message.content === "string") {
    throw new Error("expected a user message with content blocks");
  }
  const block = message.content[0];
  if (block.type !== "text") {
    throw new Error("expected a text block");
  }
  return block.text;
}

function settingsFor(keepRecentTokens: number, reserveTokens = 16384): CompactionSettings {
  return { enabled: true, reserveTokens, keepRecentTokens };
}

describe("token accounting", () => {
  it("estimates chars / 4 per message, rounded up", () => {
    const cases: Array<[SessionMessage, number]> = [
      [{ role: "user", content: "12345", timestamp: 0 }, 2],
      [{ role: "user", content: [text("1234"), text("5678")], timestamp: 0 }, 2],
      // Images in user content are not counted.
      [{ role: "user", content: [image()], timestamp: 0 }, 0],
      [
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "t",
          content: [image(), text("1234")],
          isError: false,
          timestamp: 0,
        },
        1201,
      ],
      [{ role: "custom", customType: "c", content: [image()], display: true, timestamp: 0 }, 1200],
      [{ role: "custom", customType: "c", content: "12345678", display: true, timestamp: 0 }, 2],
      [
        {
          role: "bashExecution",
          command: "ls",
          output: "ab",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 0,
        },
        1,
      ],
      [{ role: "branchSummary", summary: "123456789", fromId: "x", timestamp: 0 }, 3],
      [{ role: "compactionSummary", summary: "1234", tokensBefore: 9, timestamp: 0 }, 1],
    ];
    for (const [message, expected] of cases) {
      expect(estimateTokens(message)).toBe(expected);
    }
    // Assistant: text + thinking + tool name + JSON of the arguments.
    const b = new TranscriptBuilder();
    b.assistant([text("1234"), thinking("5678"), toolCall("c", "read", { path: "a" })]);
    const assistant = toSessionMessage(buildSessionContext(b.entries).messages[0]);
    expect(estimateTokens(assistant)).toBe(Math.ceil((4 + 4 + 4 + '{"path":"a"}'.length) / 4));
    // An unknown role counts as nothing.
    expect(estimateTokens(toSessionMessage({ role: "mystery", content: "x".repeat(400) }))).toBe(0);
  });

  it("uses totalTokens when set and the component sum otherwise", () => {
    expect(calculateContextTokens(usage(100, 20, 30, 40, 7))).toBe(7);
    expect(calculateContextTokens(usage(100, 20, 30, 40, 0))).toBe(190);
  });

  it("ignores the usage of aborted and errored assistant messages", () => {
    const entries = SCENARIOS.erroredLastAssistant();
    expect(getLastAssistantUsage(entries)?.input).toBe(5000);
    const messages = buildSessionContext(entries).messages.map(toSessionMessage);
    const estimate = estimateContextTokens(messages);
    expect(estimate.lastUsageIndex).toBe(1);
    expect(estimate.usageTokens).toBe(5170);
    // user 20 + aborted assistant "partial" 2 + user 20 + errored assistant 0
    expect(estimate.trailingTokens).toBe(42);
    expect(estimate.tokens).toBe(5212);
    expect(getLastAssistantUsage([])).toBeUndefined();
    expect(estimateContextTokens([])).toEqual({
      tokens: 0,
      usageTokens: 0,
      trailingTokens: 0,
      lastUsageIndex: null,
    });
  });

  it("triggers when less than the reserve is free", () => {
    const settings = DEFAULT_COMPACTION_SETTINGS;
    expect(settings).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(shouldCompact(183616, 200000, settings)).toBe(false);
    expect(shouldCompact(183617, 200000, settings)).toBe(true);
    expect(shouldCompact(199999, 200000, { ...settings, enabled: false })).toBe(false);
  });
});

describe("cut point", () => {
  it("cuts at a user message when the budget ends on a turn boundary", () => {
    const entries = SCENARIOS.plain();
    expect(findCutPoint(entries, 0, entries.length, 40)).toEqual({
      firstKeptEntryIndex: 6,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
    // The budget is crossed on an assistant message: a split turn.
    expect(findCutPoint(entries, 0, entries.length, 60)).toEqual({
      firstKeptEntryIndex: 5,
      turnStartIndex: 4,
      isSplitTurn: true,
    });
  });

  it("keeps everything when the budget is never reached", () => {
    const entries = SCENARIOS.plain();
    expect(findCutPoint(entries, 0, entries.length, 20000)).toEqual({
      firstKeptEntryIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
    expect(findCutPoint([], 0, 0, 10)).toEqual({
      firstKeptEntryIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it("never cuts at a tool result", () => {
    const entries = SCENARIOS.cutOnToolResult();
    // The budget is crossed on the tool result e4; the cut is the assistant e6.
    expect(findCutPoint(entries, 0, entries.length, 45)).toEqual({
      firstKeptEntryIndex: 6,
      turnStartIndex: 2,
      isSplitTurn: true,
    });
    // Only a tool result follows: fall back to the first cut point.
    const trailing = SCENARIOS.onlyToolResultAfter();
    expect(findCutPoint(trailing, 0, trailing.length, 40)).toEqual({
      firstKeptEntryIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it("moves the cut back over settings entries (and then reports a split turn)", () => {
    const entries = SCENARIOS.settingsBeforeUser();
    expect(findCutPoint(entries, 0, entries.length, 30)).toEqual({
      firstKeptEntryIndex: 2,
      turnStartIndex: 0,
      isSplitTurn: true,
    });
  });

  it("finds the start of a turn", () => {
    const entries = SCENARIOS.bash();
    // e2 is a bash execution: it starts a turn like a user message.
    expect(findTurnStartIndex(entries, 7, 0)).toBe(6);
    expect(findTurnStartIndex(entries, 1, 0)).toBe(0);
    expect(findTurnStartIndex(entries, 1, 1)).toBe(-1);
    const custom = SCENARIOS.customAndBranch();
    // e3 is a custom_message, e10 a branch_summary.
    expect(findTurnStartIndex(custom, 4, 0)).toBe(3);
    expect(findTurnStartIndex(custom, 11, 0)).toBe(10);
  });

  it("works on a path taken from the transcript store", () => {
    const store = TranscriptStore.inMemory("/tmp/summary-test");
    store.appendMessage({ role: "user", content: textOfTokens(30), timestamp: 1 });
    store.appendMessage({
      role: "assistant",
      content: [text(textOfTokens(30))],
      usage: usage(30, 30),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = store.appendMessage({ role: "user", content: textOfTokens(30), timestamp: 3 });
    store.appendMessage({
      role: "assistant",
      content: [text(textOfTokens(30))],
      usage: usage(90, 30),
      stopReason: "stop",
      timestamp: 4,
    });
    const preparation = prepareCompaction(store.getBranch(), settingsFor(60));
    expect(preparation?.firstKeptEntryId).toBe(kept);
    expect(preparation?.isSplitTurn).toBe(false);
    expect(preparation?.messagesToSummarize).toHaveLength(2);
    expect(preparation?.tokensBefore).toBe(120);
  });
});

describe("prepareCompaction", () => {
  it("returns undefined for an empty path and right after a compaction", () => {
    expect(prepareCompaction([], settingsFor(10))).toBeUndefined();
    expect(prepareCompaction(SCENARIOS.endsWithCompaction(), settingsFor(10))).toBeUndefined();
  });

  it("starts at the previous compaction's first kept entry and carries its file lists", () => {
    const preparation = prepareCompaction(SCENARIOS.previousCompaction(), settingsFor(40));
    expect(preparation?.previousSummary).toContain("Earlier work.");
    expect(preparation?.firstKeptEntryId).toBe("e10");
    // e2..e4 (kept by the previous compaction) and e6..e9; the compaction itself is skipped.
    expect(preparation?.messagesToSummarize.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect([...(preparation?.fileOps.read ?? [])]).toEqual([
      "old/read.ts",
      "old/both.ts",
      "src/kept-read.ts",
    ]);
    expect([...(preparation?.fileOps.edited ?? [])]).toEqual(["old/mod.ts", "old/both.ts"]);
    // The usage of the last assistant message (240 in, 20 out); nothing comes after it.
    expect(preparation?.tokensBefore).toBe(260);
  });

  it("does not carry file lists from a hook compaction", () => {
    const preparation = prepareCompaction(SCENARIOS.previousCompactionFromHook(), settingsFor(40));
    expect([...(preparation?.fileOps.read ?? [])]).toEqual(["src/kept-read.ts"]);
    expect([...(preparation?.fileOps.edited ?? [])]).toEqual(["old/both.ts"]);
  });

  it("starts after the previous compaction when its first kept entry is not on the path", () => {
    const preparation = prepareCompaction(
      SCENARIOS.previousCompactionMissingFirstKept(),
      settingsFor(40),
    );
    expect(preparation?.messagesToSummarize.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("splits a turn into history and turn prefix", () => {
    const preparation = prepareCompaction(SCENARIOS.splitTurn(), settingsFor(40));
    expect(preparation?.isSplitTurn).toBe(true);
    expect(preparation?.firstKeptEntryId).toBe("e9");
    expect(preparation?.messagesToSummarize).toHaveLength(2);
    expect(preparation?.turnPrefixMessages).toHaveLength(7);
    // File operations of the turn prefix count too.
    expect([...(preparation?.fileOps.written ?? [])]).toEqual(["db/migrate.sql"]);
  });
});

describe("serialization", () => {
  it("serializes every message kind and truncates tool results", () => {
    const messages = buildSessionContext(SCENARIOS.toolsAndFiles()).messages.map(toSessionMessage);
    const serialized = serializeConversation(convertToLlm(messages));
    expect(serialized).toContain("[User]: Please refactor the parser.");
    expect(serialized).toContain("[Assistant thinking]: I should read the parser first.");
    expect(serialized).toContain('[Assistant tool calls]: read(path="src/parser.ts")');
    expect(serialized).toContain('read(path="src/lexer.ts", offset=10, limit=20)');
    expect(serialized).toContain('bash(command="pnpm test", timeout=60)');
    expect(serialized).toContain("\n\n[... 1000 more characters truncated]");
    expect(serialized).toContain("[Assistant]: One test fails.\nLooking into it.");
    // Images are dropped; the text blocks of one result are joined without a separator.
    expect(serialized).toContain("[Tool result]: a picture and some text");
  });

  it("wraps the custom roles for the model", () => {
    const messages = buildSessionContext(SCENARIOS.bash()).messages.map(toSessionMessage);
    const llm = convertToLlm(messages);
    // The excluded bash execution is gone, the other four became user messages.
    expect(llm).toHaveLength(messages.length - 1);
    const serialized = serializeConversation(llm);
    expect(serialized).toContain("[User]: Ran `ls -la`\n```\ntotal 0\nfile.txt\n```");
    expect(serialized).not.toContain("secrets.env");
    expect(serialized).toContain("[User]: Ran `sleep 100`\n(no output)\n\n(command cancelled)");
    expect(serialized).toContain(
      "```\n\nCommand exited with code 2\n\n[Output truncated. Full output: /tmp/pi-bash-1.log]",
    );

    const summaries = convertToLlm([
      { role: "compactionSummary", summary: "S", tokensBefore: 1, timestamp: 5 },
      { role: "branchSummary", summary: "B", fromId: "x", timestamp: 6 },
      { role: "custom", customType: "c", content: "C", display: true, timestamp: 7 },
    ]);
    expect(summaries).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nS\n</summary>",
          },
        ],
        timestamp: 5,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nB</summary>",
          },
        ],
        timestamp: 6,
      },
      { role: "user", content: [{ type: "text", text: "C" }], timestamp: 7 },
    ]);
  });
});

describe("compact", () => {
  it("normal case: one call, the prompt golden, the assembled result", async () => {
    // The two image tool results weigh 1200 tokens each, so this budget is
    // reached on the user message e9 and the cut is a clean turn boundary.
    const preparation = prepareCompaction(SCENARIOS.toolsAndFiles(), settingsFor(2445));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    expect(preparation.isSplitTurn).toBe(false);
    const { complete, calls } = fakeComplete([reply("## Goal\nRefactor the parser.")]);
    const result = await compact(preparation, {
      model: MODEL,
      apiKey: "sk-test",
      customInstructions: "the failing test",
      complete,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(MODEL);
    expect(calls[0].options).toEqual({
      maxTokens: 13107,
      signal: undefined,
      apiKey: "sk-test",
      headers: undefined,
    });
    expect(calls[0].context.systemPrompt).toMatchSnapshot("system prompt");
    expect(promptText(calls[0])).toMatchSnapshot("history prompt");
    expect(result).toEqual({
      summary:
        "## Goal\nRefactor the parser.\n\n" +
        "<read-files>\nsrc/lexer.ts\n</read-files>\n\n" +
        "<modified-files>\nsrc/new-file.ts\nsrc/parser.ts\n</modified-files>",
      firstKeptEntryId: "e9",
      tokensBefore: 3010,
      details: {
        readFiles: ["src/lexer.ts"],
        modifiedFiles: ["src/new-file.ts", "src/parser.ts"],
      },
    });
  });

  it("split turn: two calls in order, both prompt goldens, the merged summary", async () => {
    const preparation = prepareCompaction(SCENARIOS.splitTurn(), settingsFor(40, 10000));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const { complete, calls } = fakeComplete([reply("HISTORY"), reply("TURN PREFIX")]);
    const result = await compact(preparation, {
      model: MODEL,
      customInstructions: "only the history summary gets this",
      complete,
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.options?.maxTokens)).toEqual([8000, 5000]);
    expect(promptText(calls[0])).toMatchSnapshot("history prompt");
    expect(promptText(calls[1])).toMatchSnapshot("turn prefix prompt");
    expect(promptText(calls[0])).toContain("Additional focus: only the history summary gets this");
    expect(promptText(calls[1])).not.toContain("Additional focus");
    expect(result.summary).toBe(
      "HISTORY\n\n---\n\n**Turn Context (split turn):**\n\nTURN PREFIX\n\n" +
        "<modified-files>\ndb/driver.ts\ndb/migrate.sql\n</modified-files>",
    );
    expect(result.firstKeptEntryId).toBe("e9");
    expect(result.details).toEqual({
      readFiles: [],
      modifiedFiles: ["db/driver.ts", "db/migrate.sql"],
    });
  });

  it("split turn without history: no history call", async () => {
    const preparation = prepareCompaction(SCENARIOS.splitTurnNoHistory(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const { complete, calls } = fakeComplete([reply("TURN PREFIX")]);
    const result = await compact(preparation, { model: MODEL, complete });
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.maxTokens).toBe(8192);
    expect(result.summary.startsWith("No prior history.\n\n---\n\n")).toBe(true);
  });

  it("previous compaction: the update prompt with the previous summary", async () => {
    const preparation = prepareCompaction(SCENARIOS.previousCompaction(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const { complete, calls } = fakeComplete([reply("UPDATED")]);
    await compact(preparation, { model: MODEL, complete });
    expect(promptText(calls[0])).toMatchSnapshot("update prompt");
  });

  it("joins the text blocks of the reply and ignores the rest", async () => {
    const { complete } = fakeComplete([
      reply("", {
        content: [
          { type: "text", text: "one" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "two" },
        ],
      }),
    ]);
    const summary = await generateSummary([{ role: "user", content: "hi", timestamp: 0 }], {
      model: MODEL,
      reserveTokens: 100,
      complete,
    });
    expect(summary).toBe("one\ntwo");
  });

  it("throws on a model error, with pi's messages", async () => {
    const messages: SessionMessage[] = [{ role: "user", content: "hi", timestamp: 0 }];
    const failed = (errorMessage?: string) =>
      fakeComplete([reply("", { stopReason: "error", errorMessage })]).complete;

    await expect(
      generateSummary(messages, { model: MODEL, reserveTokens: 100, complete: failed("429") }),
    ).rejects.toThrow("Summarization failed: 429");
    await expect(
      generateSummary(messages, { model: MODEL, reserveTokens: 100, complete: failed() }),
    ).rejects.toThrow("Summarization failed: Unknown error");
    await expect(
      generateTurnPrefixSummary(messages, {
        model: MODEL,
        reserveTokens: 100,
        complete: failed("429"),
      }),
    ).rejects.toThrow("Turn prefix summarization failed: 429");

    const preparation = prepareCompaction(SCENARIOS.splitTurn(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const { complete } = fakeComplete([
      reply("fine"),
      reply("", { stopReason: "error", errorMessage: "prefix down" }),
    ]);
    await expect(compact(preparation, { model: MODEL, complete })).rejects.toThrow(
      "Turn prefix summarization failed: prefix down",
    );
    // A throwing model call is not wrapped.
    const throwing: CompleteFn = async () => {
      throw new Error("socket closed");
    };
    await expect(compact(preparation, { model: MODEL, complete: throwing })).rejects.toThrow(
      "socket closed",
    );
  });

  it("passes the abort signal, headers and reasoning level to the model call", async () => {
    const preparation = prepareCompaction(SCENARIOS.splitTurn(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const controller = new AbortController();
    const headers = { "x-test": "1" };
    const reasoningModel: Model<Api> = { ...MODEL, reasoning: true };

    const first = fakeComplete([reply("a"), reply("b")]);
    await compact(preparation, {
      model: reasoningModel,
      apiKey: "sk-test",
      headers,
      signal: controller.signal,
      thinkingLevel: "high",
      complete: first.complete,
    });
    expect(first.calls).toHaveLength(2);
    for (const call of first.calls) {
      expect(call.options?.signal).toBe(controller.signal);
      expect(call.options?.headers).toBe(headers);
      expect(call.options?.apiKey).toBe("sk-test");
      expect(call.options?.reasoning).toBe("high");
    }

    // No reasoning option for "off", or for a model without reasoning.
    const off = fakeComplete([reply("a"), reply("b")]);
    await compact(preparation, {
      model: reasoningModel,
      thinkingLevel: "off",
      complete: off.complete,
    });
    const plainModel = fakeComplete([reply("a"), reply("b")]);
    await compact(preparation, {
      model: MODEL,
      thinkingLevel: "high",
      complete: plainModel.complete,
    });
    for (const call of [...off.calls, ...plainModel.calls]) {
      expect(call.options && "reasoning" in call.options).toBe(false);
    }
  });

  it("rejects a reply with no text (aborted, or all output spent on thinking) unless asked for pi's behaviour", async () => {
    const preparation = prepareCompaction(SCENARIOS.plain(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const { complete } = fakeComplete([
      reply("", { content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
    ]);
    await expect(compact(preparation, { model: MODEL, complete })).rejects.toThrow(
      "Summarization failed: the model returned no text",
    );
    const again = fakeComplete([
      reply("", { content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
    ]);
    const result = await compact(preparation, {
      model: MODEL,
      complete: again.complete,
      rejectEmptySummary: false,
    });
    expect(result.summary).toBe("");
  });

  it("uses pi-ai's completeSimple when no model call is injected", async () => {
    const preparation = prepareCompaction(SCENARIOS.splitTurn(), settingsFor(40));
    if (!preparation) {
      throw new Error("expected a preparation");
    }
    const script = new ScriptedModel([
      { kind: "text", text: "HISTORY" },
      { kind: "text", text: "TURN PREFIX" },
    ]);
    try {
      const result = await compact(preparation, { model: script.model, apiKey: "sk-test" });
      expect(result.summary.startsWith("HISTORY\n\n---\n\n")).toBe(true);
      expect(result.summary).toContain("TURN PREFIX");
      expect(script.calls.map((c) => c.maxTokens)).toEqual([13107, 8192]);
      expect(script.calls.map((c) => c.apiKey)).toEqual(["sk-test", "sk-test"]);
      expect(script.remaining).toBe(0);
    } finally {
      script.dispose();
    }
  });
});
