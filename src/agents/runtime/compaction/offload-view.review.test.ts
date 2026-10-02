/**
 * REVIEW (adversarial pass, PLAN-52A): the policy's transcript view must show
 * the same messages `buildSessionContext` renders. These tests fail on the
 * current code; each one states the defect in its name.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT_PREFIX } from "../../../auto-reply/heartbeat.js";
import { renderStubText } from "../context-pruning/offload-stubs.js";
import { TranscriptStore } from "../transcript/store.js";
import { planToolOutputStubs } from "./cut.js";
import { selectThreads } from "./ledger.js";
import { DEFAULT_OFFLOAD_SETTINGS, planOffload, shouldOffload } from "./offload-policy.js";
import { prepareCompaction } from "./summary/index.js";
import { PROACTIVE_RECALL_HEADER } from "./transcript-recall.js";
import { buildTranscriptView, parseJsonl } from "./transcript-view.js";

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  api: "anthropic-messages",
  stopReason: "stop",
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
  timestamp: Date.now(),
});

describe("REVIEW offload view vs buildSessionContext", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-offload-review-"));
    file = path.join(dir, "s.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The shape of every real session on this box: the runner appends a
   * `bitterbot.cache-ttl` custom entry after each run, so a custom entry sits
   * right before every user message.
   */
  function buildRealShape(store: TranscriptStore, turns: number, chars: number) {
    store.appendModelChange("anthropic", "claude-test");
    store.appendThinkingLevelChange("off");
    for (let t = 1; t <= turns; t++) {
      store.appendMessage(user(`question ${t} ${"q".repeat(chars)}`));
      store.appendMessage(assistant(`answer ${t} ${"a".repeat(chars)}`));
      store.appendCustomEntry("bitterbot.cache-ttl", { timestamp: Date.now() });
    }
  }

  it("a summary compaction that cuts at a user message (firstKeptEntryId = the custom entry before it): the view misses the kept messages", async () => {
    const store = TranscriptStore.open(file);
    buildRealShape(store, 8, 4_000); // ~1k tokens per message

    // What /compact, the runner's overflow compaction and the overflow
    // fallback all do: pi's summary cut.
    const prep = prepareCompaction(store.getBranch(), {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 3_500,
    });
    expect(prep).toBeDefined();
    const firstKept = store.getEntry(prep!.firstKeptEntryId)!;
    // Precondition (pi behaviour, kept by the port): the cut moved back onto
    // the custom entry before the user message.
    expect(firstKept.type).toBe("custom");
    store.appendCompaction("LLM summary", prep!.firstKeptEntryId, 12_345, {
      readFiles: [],
      modifiedFiles: [],
    });
    // The conversation goes on after the compaction.
    for (let t = 9; t <= 14; t++) {
      store.appendMessage(user(`question ${t} ${"q".repeat(40_000)}`));
      store.appendMessage(assistant(`answer ${t} ${"a".repeat(40_000)}`));
      store.appendCustomEntry("bitterbot.cache-ttl", { timestamp: Date.now() });
    }

    const rendered = store
      .buildSessionContext()
      .messages.filter((m) => m.role !== "compactionSummary");
    const view = buildTranscriptView({
      records: parseJsonl(fs.readFileSync(file, "utf8")),
      sessionIdFallback: "x",
      heartbeatPrompts: [],
    });
    // The model sees `rendered.length` messages; the planner must see the same.
    expect(view.entries.length).toBe(rendered.length);
  });

  it("the next offload drops the kept messages of that summary compaction without listing them in the ledger range", () => {
    const store = TranscriptStore.open(file);
    buildRealShape(store, 8, 4_000);
    const prep = prepareCompaction(store.getBranch(), {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 3_500,
    })!;
    store.appendCompaction("LLM summary", prep.firstKeptEntryId, 12_345);
    for (let t = 9; t <= 14; t++) {
      store.appendMessage(user(`question ${t} ${"q".repeat(40_000)}`));
      store.appendMessage(assistant(`answer ${t} ${"a".repeat(40_000)}`));
      store.appendCustomEntry("bitterbot.cache-ttl", { timestamp: Date.now() });
    }
    const textOf = (m: Record<string, unknown>) =>
      (m.content as Array<{ text: string }>)[0]!.text.slice(0, 12);
    const visibleBefore = store
      .buildSessionContext()
      .messages.filter((m) => m.role !== "compactionSummary")
      .map(textOf);

    const records = parseJsonl(fs.readFileSync(file, "utf8"));
    const view = buildTranscriptView({ records, sessionIdFallback: "x", heartbeatPrompts: [] });
    const plan = planOffload({
      sessionId: view.sessionId,
      trigger: "turn-end",
      entries: view.entries,
      stubbed: view.stubbedIds,
      fixedTokens: 1_000,
      contextWindow: 100_000,
      settings: { ...DEFAULT_OFFLOAD_SETTINGS, elideHeartbeats: false },
      previousCompactionId: view.latestCompaction?.id ?? null,
      previousOffloads: view.previousOffloads,
      openItems: [],
      workingMemoryFlushed: false,
    });
    expect(plan.kind).toBe("horizon");
    const range = plan.compaction!.details.elided;
    store.appendCompaction(
      plan.compaction!.summary,
      plan.compaction!.firstKeptEntryId,
      plan.compaction!.tokensBefore,
      plan.compaction!.details,
    );
    const visibleAfter = new Set(
      store
        .buildSessionContext()
        .messages.filter((m) => m.role !== "compactionSummary")
        .map(textOf),
    );
    const dropped = visibleBefore.filter((t) => !visibleAfter.has(t));
    // Every message this offload removed from the window must be inside the
    // range the ledger reports (that is the "nothing is lost" contract).
    const inRange = new Set(
      view.allEntries
        .filter((e) => e.line >= range.jsonlLineFrom && e.line <= range.jsonlLineTo)
        .map((e) => e.text.slice(0, 12)),
    );
    const unaccounted = dropped.filter((t) => !inRange.has(t));
    expect(unaccounted).toEqual([]);
  });

  it("a heartbeat prompt behind queued System event lines is not recognised and its System line becomes a 'user thread'", () => {
    // Real shape (main agent, 2026-08-18): system events are prepended to the
    // heartbeat prompt; the skill name comes from a remote peer.
    const hb = [
      'System: [2026-08-18 04:35:50 EDT] Skill "peer-chosen-name" from peer 12D3KooWRNqM held in quarantine',
      "",
      HEARTBEAT_PROMPT_PREFIX,
      "Current time: Tuesday, August 18th, 2026 - 5:02 AM",
    ].join("\n");
    const store = TranscriptStore.open(file);
    store.appendMessage(user(hb));
    store.appendMessage(assistant("HEARTBEAT_OK"));
    const view = buildTranscriptView({
      records: parseJsonl(fs.readFileSync(file, "utf8")),
      sessionIdFallback: "x",
      heartbeatPrompts: [HEARTBEAT_PROMPT_PREFIX.trim()],
    });
    expect(view.entries[0]!.isHeartbeatPrompt).toBe(true);
    expect(selectThreads(view.entries)).toEqual([]);
  });

  it("with proactive recall on, the ledger's thread line for a user turn is the recall header, not what the user said", () => {
    // attempt.ts: effectivePrompt = `${preface}\n\n${prompt}`, persisted as the user message.
    const preface = `${PROACTIVE_RECALL_HEADER}\n[turn 3, e1a2b3c4d L12] USER: earlier text`;
    const store = TranscriptStore.open(file);
    store.appendMessage(user(`${preface}\n\nwhat was the database password policy again?`));
    store.appendMessage(assistant("it was ..."));
    const view = buildTranscriptView({
      records: parseJsonl(fs.readFileSync(file, "utf8")),
      sessionIdFallback: "x",
      heartbeatPrompts: [],
    });
    expect(selectThreads(view.entries)[0]!.text).toContain("database password policy");
  });

  it("an offload after a summary-policy compaction must not tell the model there was nothing earlier", () => {
    const store = TranscriptStore.open(file);
    // Turns 1-3, then an LLM summary that keeps from the assistant of turn 3
    // (a message id, so the view resolves it).
    buildRealShape(store, 3, 100);
    const branch = store.getBranch();
    const keptAssistant = branch.filter((e) => e.type === "message").at(-1)!;
    store.appendCompaction("## Goal\nThe user wants X. Decision: use Y.", keptAssistant.id, 9_999);
    for (let t = 4; t <= 9; t++) {
      store.appendMessage(user(`question ${t} ${"q".repeat(40_000)}`));
      store.appendMessage(assistant(`answer ${t} ${"a".repeat(40_000)}`));
    }
    const view = buildTranscriptView({
      records: parseJsonl(fs.readFileSync(file, "utf8")),
      sessionIdFallback: "x",
      heartbeatPrompts: [],
    });
    const plan = planOffload({
      sessionId: view.sessionId,
      trigger: "turn-end",
      entries: view.entries,
      stubbed: view.stubbedIds,
      fixedTokens: 1_000,
      contextWindow: 100_000,
      settings: { ...DEFAULT_OFFLOAD_SETTINGS, elideHeartbeats: false },
      previousCompactionId: view.latestCompaction?.id ?? null,
      previousOffloads: view.previousOffloads,
      openItems: [],
      workingMemoryFlushed: false,
    });
    expect(plan.kind).toBe("horizon");
    const ledger = plan.compaction!.summary;
    // Turns 1-3 are hidden by the earlier summary compaction, whose summary
    // this ledger replaces. The ledger must still account for them (carry
    // the old summary, or at least point at the range).
    expect(ledger).not.toContain("Earlier offloads in this session: none.");
  });

  it("the planner stubs an image-only tool result although recall_range cannot return an image", () => {
    const entries = [1, 2, 3, 4].map((i) => ({
      id: `r${i}`,
      line: i + 1,
      role: "toolResult" as const,
      text: "",
      tokens: 1_200, // one image, no text (a screenshot)
      turn: 1,
      toolName: "browser",
      toolCallId: `call-${i}`,
      toolCallIds: [],
      images: 1,
      isHeartbeatPrompt: false,
      isHeartbeatAck: false,
    }));
    const stubs = planToolOutputStubs({
      entries,
      stubbed: new Map(),
      targetTokens: 0,
      spareRecentToolResults: 2,
      minTokens: 1_000,
    });
    // Each stub would render as "... 0 chars; full text: recall_range ..."
    // and the image is gone from the model's view for good.
    expect(
      stubs.map((s) => renderStubText({ toolCallId: "x", chars: s.chars, toolName: s.toolName })),
    ).toEqual([]);
  });

  it("when the provider says 55% but chars/4 says 34%, the threshold fires every turn and the planner does nothing", () => {
    // CJK text: about one token per character, so chars/4 is 4x too low.
    const window = 100_000;
    const realPromptTokens = 60_000;
    expect(
      shouldOffload({
        trigger: "turn-end",
        promptTokens: realPromptTokens,
        contextWindow: window,
        settings: DEFAULT_OFFLOAD_SETTINGS,
      }),
    ).toBe(true);
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `e${i}`,
      line: i + 2,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: "字".repeat(2_000),
      tokens: 500, // estimate; the real size is ~2000 tokens
      turn: Math.floor(i / 2) + 1,
      toolCallIds: [],
      images: 0,
      isHeartbeatPrompt: false,
      isHeartbeatAck: false,
      promptTokensActual: i % 2 === 1 ? 2_000 * (i + 1) : undefined,
    }));
    const plan = planOffload({
      sessionId: "s",
      trigger: "turn-end",
      entries,
      stubbed: new Map(),
      fixedTokens: 1_000,
      contextWindow: window,
      settings: { ...DEFAULT_OFFLOAD_SETTINGS, elideHeartbeats: false },
      previousCompactionId: null,
      previousOffloads: [],
      openItems: [],
      workingMemoryFlushed: false,
    });
    expect(plan.kind).not.toBe("none");
  });
});
