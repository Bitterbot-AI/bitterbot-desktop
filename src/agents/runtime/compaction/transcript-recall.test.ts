import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../transcript/store.js";
import {
  Bm25,
  buildProactiveRecallPreface,
  chunkDialogue,
  PROACTIVE_RECALL_HEADER,
  PROACTIVE_RECALL_MAX_CHARS,
  renderProactiveRecall,
  tokenize,
} from "./transcript-recall.js";
import type { PolicyEntry } from "./types.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "p",
  model: "m",
  stopReason: "stop",
  timestamp: 2,
});
const toolResult = (text: string) => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

const OFFLOAD_DETAILS = {
  policy: "offload",
  version: 1,
  trigger: "turn-end",
  elided: { firstEntryId: "a", lastEntryId: "b", turnFrom: 1, turnTo: 2 },
  previousOffloads: [],
};

describe("proactive transcript recall (PLAN-52A L1a)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-recall-"));
    file = path.join(dir, "s.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Three turns; the first two are offloaded when `details` says so. */
  function build(details: unknown): { kept: string } {
    const store = TranscriptStore.open(file);
    store.appendMessage(user("Please book the venue for the Lisbon offsite, budget 4200 euros."));
    store.appendMessage(assistant("Booked Quinta do Vale for 14 March; the deposit is 800 euros."));
    store.appendMessage(toolResult("SECRET-TOOL-OUTPUT venue contract text Quinta"));
    store.appendMessage(user("Also remind me that Priya prefers window seats."));
    store.appendMessage(assistant("Noted: Priya prefers window seats."));
    const kept = store.appendMessage(user("What is the weather in Porto tomorrow?"));
    store.appendMessage(assistant("Sunny, 19 degrees."));
    store.appendCompaction("[Context offloaded] ledger", kept, 5000, details);
    return { kept };
  }
  const preface = (query: string) =>
    buildProactiveRecallPreface({
      sessionFile: file,
      sessionIdFallback: "s",
      query,
      heartbeatPrompts: [],
    });

  it("injects matching excerpts of the offloaded range with their addresses", () => {
    build(OFFLOAD_DETAILS);
    const text = preface("what was the deposit for the venue?")!;
    const lines = text.split("\n");
    expect(lines[0]).toBe(PROACTIVE_RECALL_HEADER);
    expect(text).toContain(
      "ASSISTANT: Booked Quinta do Vale for 14 March; the deposit is 800 euros.",
    );
    expect(text).toContain(
      "USER: Please book the venue for the Lisbon offsite, budget 4200 euros.",
    );
    expect(lines[1]).toMatch(/^\[turn \d+, e[0-9a-f]{8} L\d+\] /);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(text.length).toBeLessThanOrEqual(
      PROACTIVE_RECALL_MAX_CHARS + PROACTIVE_RECALL_HEADER.length + 1,
    );
  });

  it("never includes tool outputs or entries still in the window", () => {
    build(OFFLOAD_DETAILS);
    expect(preface("Quinta venue contract SECRET-TOOL-OUTPUT") ?? "").not.toContain(
      "SECRET-TOOL-OUTPUT",
    );
    // "Porto" and "weather" only occur in the kept turn.
    expect(preface("weather Porto")).toBeUndefined();
  });

  it("is silent without an offload compaction, without a match, and for an empty query", () => {
    build({ readFiles: [], modifiedFiles: [] });
    expect(preface("deposit venue")).toBeUndefined();
    fs.rmSync(file);
    build(OFFLOAD_DETAILS);
    expect(preface("zebra xylophone quantum")).toBeUndefined();
    expect(preface("   ")).toBeUndefined();
    expect(
      buildProactiveRecallPreface({
        sessionFile: path.join(dir, "missing.jsonl"),
        sessionIdFallback: "s",
        query: "deposit",
        heartbeatPrompts: [],
      }),
    ).toBeUndefined();
  });

  it("a damaged offload details object does not break the view", () => {
    build({ policy: "offload" });
    expect(preface("deposit venue")).toBeUndefined();
    fs.rmSync(file);
    build({ policy: "offload", elided: { firstEntryId: "a", lastEntryId: "b" } });
    expect(preface("deposit venue")).toContain("800 euros");
  });

  it("skips heartbeat prompts and acknowledgements when indexing", () => {
    const entry = (
      id: string,
      role: "user" | "assistant",
      text: string,
      hb = false,
    ): PolicyEntry => ({
      id,
      line: 1,
      role,
      text,
      tokens: 1,
      turn: 1,
      toolCallIds: [],
      images: 0,
      isHeartbeatPrompt: hb && role === "user",
      isHeartbeatAck: hb && role === "assistant",
    });
    const chunks = chunkDialogue([
      entry("a", "user", "heartbeat check the deposit", true),
      entry("b", "assistant", "HEARTBEAT_OK", true),
      entry("c", "user", "the deposit is 800"),
    ]);
    expect(chunks.map((c) => c.entryId)).toEqual(["c"]);
    expect(renderProactiveRecall([entry("c", "user", "the deposit is 800")], "deposit")).toContain(
      "800",
    );
  });

  it("ranks by BM25 and drops stop words", () => {
    expect(tokenize("What is the deposit for src/agents/x.ts?")).toEqual([
      "deposit",
      "src/agents/x.ts",
    ]);
    const index = new Bm25([
      { entryId: "1", line: 1, turn: 1, role: "user", text: "the deposit was paid" },
      { entryId: "2", line: 2, turn: 2, role: "user", text: "deposit deposit deposit refund" },
      { entryId: "3", line: 3, turn: 3, role: "user", text: "unrelated text about seats" },
    ]);
    const hits = index.search("deposit refund", 3);
    expect(hits.map((h) => h.chunk.entryId)).toEqual(["2", "1"]);
  });
});
