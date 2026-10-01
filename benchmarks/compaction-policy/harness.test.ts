/**
 * Pure parts of the compaction-policy harness: stitching, message conversion,
 * probe filtering, scoring, metrics.
 */
import { describe, expect, it } from "vitest";
import type { PolicyEntry } from "../../src/agents/runtime/compaction/types.js";
import { chooseStitchRuns, rankForSetB, statsFromJsonl, stitchTranscripts } from "./corpus.js";
import { fastVerdict, scoreOf } from "./judge.js";
import { compactionWrapper, entriesToMessages } from "./messages.js";
import { filterProbes, parseJsonArray, type Probe } from "./probes.js";
import { pairedDeltas, summarizeArm, type ResultRow } from "./report.js";

const HB = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.";
const prompts = [HB];

function line(type: string, id: string, parentId: string | null, extra: Record<string, unknown>) {
  return JSON.stringify({ type, id, parentId, timestamp: "2026-09-03T10:00:00.000Z", ...extra });
}
const msg = (id: string, parentId: string | null, role: string, text: string) =>
  line("message", id, parentId, { message: { role, content: [{ type: "text", text }] } });

describe("corpus", () => {
  it("counts real turns and stitches with unique ids and re-parenting", () => {
    const a = [
      JSON.stringify({ type: "session", id: "A" }),
      msg("1", null, "user", "hello"),
      msg("2", "1", "assistant", "hi"),
      msg("3", "2", "user", HB),
    ].join("\n");
    const b = [
      JSON.stringify({ type: "session", id: "B" }),
      msg("1", null, "user", "again"),
      msg("2", "1", "assistant", "yes"),
    ].join("\n");
    const sa = statsFromJsonl("A.jsonl", a, prompts);
    expect(sa.realUserTurns).toBe(1);
    expect(sa.userTurns).toBe(2);
    const stitched = stitchTranscripts(
      [
        { stem: "A", raw: a },
        { stem: "B", raw: b },
      ],
      "stitch-01",
    );
    const recs = stitched
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(recs.filter((r) => r.type === "session")).toHaveLength(1);
    expect(recs[0]!.id).toBe("stitch-01");
    const ids = recs.filter((r) => r.type === "message").map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const firstOfB = recs.find((r) => r.id === "s1-1")!;
    expect(firstOfB.parentId).toBe("s0-3");
  });
  it("ranks set B by real turns and picks stitch runs", () => {
    const stats = [
      { file: "x.jsonl", stem: "x", realUserTurns: 10, userTurns: 40, estTokens: 100, firstTs: 1 },
      { file: "y.jsonl", stem: "y", realUserTurns: 3, userTurns: 3, estTokens: 50, firstTs: 2 },
      { file: "z.jsonl", stem: "z", realUserTurns: 6, userTurns: 6, estTokens: 500, firstTs: 3 },
      {
        file: "drill-a.jsonl",
        stem: "drill-a",
        realUserTurns: 99,
        userTurns: 99,
        estTokens: 1,
        firstTs: 4,
      },
    ];
    expect(rankForSetB(stats, new Set(), 4, 10).map((s) => s.stem)).toEqual(["x", "z"]);
    expect(chooseStitchRuns(stats, 3, 6, 5)).toHaveLength(1);
  });
});

const mk = (
  id: string,
  role: PolicyEntry["role"],
  text: string,
  extra: Partial<PolicyEntry> = {},
): PolicyEntry => ({
  id,
  line: 1,
  role,
  text,
  tokens: Math.ceil(text.length / 4),
  turn: 1,
  toolCallIds: [],
  images: 0,
  isHeartbeatPrompt: false,
  isHeartbeatAck: false,
  ...extra,
});

describe("entriesToMessages", () => {
  it("maps tool calls and results, applies stubs, drops heartbeat pairs, starts with user", () => {
    const entries = [
      mk("u1", "user", HB, { isHeartbeatPrompt: true }),
      mk("a0", "assistant", "HEARTBEAT_OK", { isHeartbeatAck: true }),
      mk("a1", "assistant", "reading", { toolCallIds: ["c1"] }),
      mk("t1", "toolResult", "X".repeat(5000), { toolCallId: "c1", toolName: "read" }),
      mk("a2", "assistant", "done"),
    ];
    const raw = (id: string) =>
      id === "a1"
        ? {
            role: "assistant",
            content: [
              { type: "text", text: "reading" },
              { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
            ],
          }
        : { role: "assistant", content: [{ type: "text", text: "done" }] };
    const stubbed = new Map([
      ["u1", "heartbeat_pair" as const],
      ["a0", "heartbeat_pair" as const],
      ["t1", "tool_result" as const],
    ]);
    const out = entriesToMessages(entries, stubbed, raw);
    expect(out[0]!.role).toBe("user"); // synthetic opener since the pair was dropped
    const asst = out[1]!;
    expect(asst.role).toBe("assistant");
    const blocks = asst.content as Array<{ type: string; id?: string }>;
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "c1")).toBe(true);
    const res = out[2]!.content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(res[0]!.type).toBe("tool_result");
    expect(res[0]!.tool_use_id).toBe("c1");
    expect(res[0]!.content).toContain("tool output offloaded");
    expect(res[0]!.content).toContain("recall_range entry t1");
    expect(compactionWrapper("L").content).toContain("<summary>\nL\n</summary>");
  });
});

describe("filterProbes", () => {
  const elided = [
    mk("u1", "user", "please use the ~/bitterbot-desktop path, never /mnt/d"),
    mk("t1", "toolResult", "DATABASE_URL=postgres://db.internal:5432/app", { toolName: "read" }),
  ];
  const kept = [mk("u2", "user", "thanks, /mnt/d is stale anyway; what about the port?")];
  it("keeps verbatim golds, tags dialogue vs tool output, rejects leaks and inventions", () => {
    const { probes, rejected } = filterProbes(
      [
        {
          type: "instruction",
          question: "Which path did I ask you to use?",
          gold: "~/bitterbot-desktop path",
          source_entry_id: "eu1",
        },
        {
          type: "tool_output",
          question: "What host was in DATABASE_URL?",
          gold: "db.internal",
          source_entry_id: "et1",
        },
        { type: "fact", question: "leak", gold: "/mnt/d" },
        { type: "fact", question: "invented", gold: "zebra protocol" },
        { type: "negative", question: "What is my dog's name?", gold: "whatever" },
        { type: "bogus", question: "x", gold: "y" },
      ],
      elided,
      kept,
      "c1",
    );
    expect(probes.map((p) => p.type)).toEqual(["instruction", "tool_output", "negative"]);
    expect(probes[0]!.answerableFromDialogue).toBe(true);
    expect(probes[1]!.needsToolOutput).toBe(true);
    expect(probes[1]!.sourceEntryId).toBe("t1");
    expect(probes[2]!.gold).toBe("NOT IN TRANSCRIPT");
    expect(rejected.map((r) => r.reason)).toEqual([
      "gold leaks into kept region",
      "gold not verbatim in elided range",
      "malformed",
    ]);
  });
  it("parses a JSON array out of surrounding prose", () => {
    expect(parseJsonArray('Here you go:\n[{"a":1}]\nthanks')).toEqual([{ a: 1 }]);
    expect(parseJsonArray("no json")).toEqual([]);
  });
});

describe("judge fast path and scoring", () => {
  const fact: Probe = {
    probeId: "p",
    cutId: "c",
    type: "fact",
    question: "q",
    gold: "db.internal",
    sourceEntryId: null,
    answerableFromDialogue: true,
    needsToolOutput: false,
  };
  const neg: Probe = { ...fact, type: "negative", gold: "NOT IN TRANSCRIPT" };
  it("exact match, abstention, and negatives", () => {
    expect(fastVerdict(fact, "The host was `db.internal`.")).toBe("correct");
    expect(fastVerdict(fact, "I don't have that information.")).toBe("abstain");
    expect(fastVerdict(fact, "It was prod-db-7.")).toBeNull();
    expect(fastVerdict(neg, "I don't have that information.")).toBe("correct");
    expect(fastVerdict(neg, "Your dog is called Rex.")).toBeNull();
    expect(scoreOf(neg, "wrong")).toEqual({ correct: 0, hallucinated: 1 });
    expect(scoreOf(neg, "abstain")).toEqual({ correct: 1, hallucinated: 0 });
    expect(scoreOf(fact, "partial")).toEqual({ correct: 0, hallucinated: 0 });
  });
});

describe("report metrics", () => {
  const row = (
    arm: 1 | 2 | 3 | 4,
    probeId: string,
    correct: number,
    extra: Partial<ResultRow> = {},
  ): ResultRow => ({
    cutId: "c",
    set: "A",
    probeId,
    probeType: "fact",
    answerableFromDialogue: true,
    needsToolOutput: false,
    arm,
    model: "claude-haiku-4-5",
    answer: "",
    verdict: correct ? "correct" : "wrong",
    judged: "fast",
    correct,
    hallucinated: 0,
    costUsd: 0.01 * arm,
    buildCostUsd: 0,
    durationMs: 1000 * arm,
    inputTokens: 100,
    cacheReadTokens: 50,
    toolCalls: arm === 4 ? 1 : 0,
    usedRecall: arm === 4,
    ...extra,
  });
  it("summarises arms and computes paired deltas over shared probes only", () => {
    const rows = [
      row(1, "p1", 0),
      row(1, "p2", 1),
      row(4, "p1", 1),
      row(4, "p2", 1),
      row(4, "p3", 1),
    ];
    const s4 = summarizeArm(rows, 4);
    expect(s4.n).toBe(3);
    expect(s4.accuracy).toBe(1);
    expect(s4.reachRate).toBe(1);
    expect(summarizeArm(rows, 1).reachRate).toBeNull();
    const d = pairedDeltas(rows, 4, 1, (r) => r.correct);
    expect(d).toEqual([1, 0]);
  });
});
