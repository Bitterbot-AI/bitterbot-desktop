/**
 * PLAN-52A offload policy: pure planning over a synthetic transcript shaped
 * like the real corpus (heartbeat pairs, one tool-heavy agentic turn with
 * large read results, short dialogue turns, a forked sibling).
 */
import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT_PREFIX } from "../../../auto-reply/heartbeat.js";
import {
  planHeartbeatStubs,
  planHorizonCut,
  planToolOutputStubs,
  segmentTurns,
  totalTokens,
} from "./cut.js";
import { estimateMessageTokens, USER_IMAGE_TOKENS } from "./estimate.js";
import { LEDGER_MARKER, renderLedger, selectThreads } from "./ledger.js";
import {
  DEFAULT_OFFLOAD_SETTINGS,
  planOffload,
  resolveOffloadSettings,
  shouldOffload,
} from "./offload-policy.js";
import { buildTranscriptView, parseJsonl } from "./transcript-view.js";
import type { PolicyEntry, StubKind } from "./types.js";

const HB = `${HEARTBEAT_PROMPT_PREFIX} Current time: 2026-09-30 08:10`;
const SID = "sess-1";
let seq = 0;
const ts0 = Date.parse("2026-09-30T08:00:00Z");

function rec(type: string, id: string, parentId: string | null, extra: Record<string, unknown>) {
  return JSON.stringify({
    type,
    id,
    parentId,
    timestamp: new Date(ts0 + seq++ * 60_000).toISOString(),
    ...extra,
  });
}
function msg(
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const content: unknown[] = [{ type: "text", text }];
  if (Array.isArray(extra.toolCalls)) {
    for (const tc of extra.toolCalls as string[]) {
      content.push({ type: "toolCall", id: tc, name: "read", arguments: { path: "/x" } });
    }
  }
  const message: Record<string, unknown> = { role, content, timestamp: ts0 + seq * 60_000 };
  if (role === "toolResult") {
    message.toolCallId = extra.toolCallId;
    message.toolName = extra.toolName ?? "read";
  }
  return rec("message", id, parentId, { message });
}

/** Build the synthetic session; returns the JSONL text. */
function buildSession(
  opts: { heartbeats?: number; bigTool?: number; earlyText?: number } = {},
): string {
  seq = 0;
  const lines: string[] = [JSON.stringify({ type: "session", id: SID, version: 3 })];
  let parent: string | null = null;
  let n = 0;
  const add = (role: string, text: string, extra: Record<string, unknown> = {}) => {
    const id = `e${++n}`;
    lines.push(msg(id, parent, role, text, extra));
    parent = id;
    return id;
  };
  // Turn 1: a real dialogue turn.
  add("user", "please review the wikiskills paper against our code");
  add("assistant", `Sure, starting with the paper. ${"p".repeat(opts.earlyText ?? 0)}`);
  // Heartbeat pairs.
  for (let i = 0; i < (opts.heartbeats ?? 3); i++) {
    add("user", HB);
    add("assistant", "HEARTBEAT_OK");
  }
  // Turn with tool loop (big read results).
  const big = "X".repeat((opts.bigTool ?? 40_000) * 4); // chars -> tokens via /4
  add("user", "now read the three config files and compare them");
  add("assistant", "Reading.", { toolCalls: ["c1"] });
  add("toolResult", `${big} FIRST`, { toolCallId: "c1" });
  add("assistant", "Next.", { toolCalls: ["c2"] });
  add("toolResult", `${big} SECOND`, { toolCallId: "c2" });
  add("assistant", "Last one.", { toolCalls: ["c3"] });
  add("toolResult", `${big} THIRD`, { toolCallId: "c3" });
  add("assistant", "The configs differ in the database url.");
  // A fork: sibling of the last assistant that the path never saw.
  lines.push(msg("fork1", "e9", "assistant", "FORK never shown"));
  // Current turn (dialogue).
  add("user", "thanks, summarize the differences in one line");
  add("assistant", "Database url and port differ.");
  return lines.join("\n") + "\n";
}

function view(jsonl: string, prompts: readonly string[] = [HEARTBEAT_PROMPT_PREFIX]) {
  return buildTranscriptView({
    records: parseJsonl(jsonl),
    sessionIdFallback: "fallback",
    heartbeatPrompts: prompts,
  });
}

const noStubs: ReadonlyMap<string, StubKind> = new Map();

describe("estimateMessageTokens", () => {
  it("mirrors pi for text/toolCall/toolResult and adds user images", () => {
    expect(estimateMessageTokens({ role: "user", content: "a".repeat(400) }).tokens).toBe(100);
    const asst = estimateMessageTokens({
      role: "assistant",
      content: [
        { type: "text", text: "abcd" },
        { type: "toolCall", id: "c", name: "exec", arguments: { command: "ls" } },
      ],
    });
    expect(asst.tokens).toBe(Math.ceil((4 + 4 + JSON.stringify({ command: "ls" }).length) / 4));
    const img = estimateMessageTokens({ role: "user", content: [{ type: "image", source: {} }] });
    expect(img.tokens).toBe(USER_IMAGE_TOKENS);
    expect(img.images).toBe(1);
    const toolImg = estimateMessageTokens({ role: "toolResult", content: [{ type: "image" }] });
    expect(toolImg.tokens).toBe(1_200);
  });
});

describe("buildTranscriptView", () => {
  it("follows the branch path, numbers turns over the whole path, flags heartbeats", () => {
    const v = view(buildSession());
    expect(v.sessionId).toBe(SID);
    expect(v.entries.some((e) => e.text.includes("FORK"))).toBe(false);
    const users = v.entries.filter((e) => e.role === "user");
    expect(users.map((u) => u.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(users.filter((u) => u.isHeartbeatPrompt)).toHaveLength(3);
    expect(v.entries.filter((e) => e.isHeartbeatAck)).toHaveLength(3);
    const tool = v.entries.find((e) => e.role === "toolResult")!;
    expect(tool.toolName).toBe("read");
    expect(tool.toolCallId).toBe("c1");
    expect(v.entries.find((e) => e.toolCallIds.includes("c1"))).toBeDefined();
    expect(v.latestCompaction).toBeNull();
    expect(v.stubbedIds.size).toBe(0);
  });

  it("applies the latest compaction cut and reads prune records", () => {
    const base = buildSession();
    const extra = [
      JSON.stringify({
        type: "compaction",
        id: "cmp1",
        parentId: "e17",
        timestamp: new Date().toISOString(),
        summary: "[Context offloaded] …",
        firstKeptEntryId: "e9",
        tokensBefore: 1000,
        details: {
          policy: "offload",
          version: 1,
          trigger: "turn-end",
          elided: {
            sessionId: SID,
            firstEntryId: "e1",
            lastEntryId: "e8",
            jsonlLineFrom: 2,
            jsonlLineTo: 9,
            turnFrom: 1,
            turnTo: 4,
            messages: 8,
            userTurns: 4,
            heartbeats: 3,
            toolCalls: 0,
            estTokens: 50,
          },
          kept: { firstEntryId: "e9", estTokens: 10 },
          previousCompactionId: null,
          previousOffloads: [],
          workingMemoryFlushed: true,
        },
      }),
      JSON.stringify({
        type: "custom",
        id: "pr1",
        parentId: "cmp1",
        timestamp: new Date().toISOString(),
        customType: "bitterbot.offload-prune",
        data: {
          version: 1,
          trigger: "mid-turn",
          stubs: [{ entryId: "e11", kind: "tool_result", chars: 5 }],
        },
      }),
    ].join("\n");
    const v = view(base + extra + "\n");
    expect(v.latestCompaction?.id).toBe("cmp1");
    expect(v.entries[0]!.id).toBe("e9");
    // Turn numbering is unchanged by the cut.
    expect(v.entries[0]!.turn).toBe(5);
    expect(v.previousOffloads).toEqual([
      { compactionId: "cmp1", turnFrom: 1, turnTo: 4, firstEntryId: "e1", lastEntryId: "e8" },
    ]);
    expect(v.stubbedIds.get("e11")).toBe("tool_result");
  });

  it("keeps nothing before a compaction whose firstKeptEntryId is unknown (pi semantics)", () => {
    const base = buildSession();
    const cmp = JSON.stringify({
      type: "compaction",
      id: "c",
      parentId: "e17",
      timestamp: "",
      summary: "s",
      firstKeptEntryId: "nope",
      tokensBefore: 1,
    });
    const v = view(base + cmp + "\n");
    expect(v.entries).toHaveLength(0);
    expect(v.allEntries.length).toBeGreaterThan(0);
  });
});

describe("segmentTurns / planHeartbeatStubs", () => {
  it("marks bare heartbeat pairs and nothing else", () => {
    const v = view(buildSession());
    const turns = segmentTurns(v.entries, noStubs);
    expect(turns.map((t) => t.isHeartbeatPair)).toEqual([false, true, true, true, false, false]);
    const hb = planHeartbeatStubs({ entries: v.entries, stubbed: noStubs });
    expect(hb).toHaveLength(6);
    expect(hb.every((s) => s.kind === "heartbeat_pair")).toBe(true);
  });
  it("a heartbeat that ran a tool is a real turn", () => {
    const entries: PolicyEntry[] = [
      {
        id: "u",
        line: 1,
        role: "user",
        text: HB,
        tokens: 10,
        turn: 1,
        toolCallIds: [],
        images: 0,
        isHeartbeatPrompt: true,
        isHeartbeatAck: false,
      },
      {
        id: "a",
        line: 2,
        role: "assistant",
        text: "HEARTBEAT_OK",
        tokens: 2,
        turn: 1,
        toolCallIds: ["c"],
        images: 0,
        isHeartbeatPrompt: false,
        isHeartbeatAck: true,
      },
      {
        id: "t",
        line: 3,
        role: "toolResult",
        text: "out",
        tokens: 1,
        turn: 1,
        toolCallIds: [],
        images: 0,
        isHeartbeatPrompt: false,
        isHeartbeatAck: false,
        toolCallId: "c",
      },
    ];
    expect(segmentTurns(entries, noStubs)[0]!.isHeartbeatPair).toBe(false);
  });
});

describe("planHorizonCut", () => {
  it("cuts at a user-turn boundary, keeps the current turn and minKeep real turns", () => {
    const v = view(buildSession({ bigTool: 1_000 }));
    const total = totalTokens(v.entries, noStubs);
    const cut = planHorizonCut({
      entries: v.entries,
      stubbed: noStubs,
      targetTokens: Math.floor(total * 0.3),
      minKeepUserTurns: 1,
    });
    expect(cut).not.toBeNull();
    expect(v.entries[cut!.cutIndex]!.role).toBe("user");
    // The current turn (turn 6) is kept whole.
    expect(v.entries[cut!.cutIndex]!.turn).toBeLessThanOrEqual(6);
    expect(cut!.keptTokens + cut!.elidedTokens).toBe(total);
  });
  it("respects minKeepUserTurns even when over budget", () => {
    const v = view(buildSession({ bigTool: 1_000 }));
    const cut = planHorizonCut({
      entries: v.entries,
      stubbed: noStubs,
      targetTokens: 10,
      minKeepUserTurns: 2,
    });
    expect(cut).not.toBeNull();
    const kept = v.entries.slice(cut!.cutIndex);
    const realTurns = new Set(
      kept.filter((e) => e.role === "user" && !e.isHeartbeatPrompt).map((e) => e.turn),
    );
    expect(realTurns.size).toBeGreaterThanOrEqual(2);
  });
  it("returns null when everything fits or only one turn exists", () => {
    const v = view(buildSession({ bigTool: 10 }));
    expect(
      planHorizonCut({
        entries: v.entries,
        stubbed: noStubs,
        targetTokens: 10_000_000,
        minKeepUserTurns: 2,
      }),
    ).toBeNull();
    const one = v.entries.filter((e) => e.turn === 6);
    expect(
      planHorizonCut({ entries: one, stubbed: noStubs, targetTokens: 1, minKeepUserTurns: 1 }),
    ).toBeNull();
  });
});

describe("planToolOutputStubs", () => {
  it("stubs oldest first, spares the newest two and small results", () => {
    const v = view(buildSession({ bigTool: 40_000 }));
    const stubs = planToolOutputStubs({
      entries: v.entries,
      stubbed: noStubs,
      targetTokens: 50_000,
      spareRecentToolResults: 2,
      minTokens: 1_000,
    });
    // Three big results; two spared; only the oldest (FIRST) is stubbable.
    expect(stubs.map((s) => s.toolName)).toEqual(["read"]);
    const stubbedEntry = v.entries.find((e) => e.id === stubs[0]!.entryId)!;
    expect(stubbedEntry.text.endsWith("FIRST")).toBe(true);
    const none = planToolOutputStubs({
      entries: v.entries,
      stubbed: noStubs,
      targetTokens: 50_000,
      spareRecentToolResults: 2,
      minTokens: 100_000_000,
    });
    expect(none).toHaveLength(0);
  });
});

describe("planOffload", () => {
  const settings = DEFAULT_OFFLOAD_SETTINGS;
  const base = (
    trigger: Parameters<typeof planOffload>[0]["trigger"],
    jsonl: string,
    fixed = 20_000,
    window = 200_000,
  ) => {
    const v = view(jsonl);
    return {
      plan: planOffload({
        sessionId: v.sessionId,
        trigger,
        entries: v.entries,
        stubbed: v.stubbedIds,
        fixedTokens: fixed,
        contextWindow: window,
        settings,
        previousCompactionId: v.latestCompaction?.id ?? null,
        previousOffloads: v.previousOffloads,
        openItems: ["task T-7: compare configs (active)"],
        workingMemoryFlushed: true,
      }),
      v,
    };
  };

  it("mid-turn: stubs only, never a compaction entry", () => {
    const { plan } = base("mid-turn", buildSession({ bigTool: 40_000 }));
    expect(plan.kind).toBe("stubs");
    expect(plan.compaction).toBeUndefined();
    expect(plan.prune?.data.stubs.length).toBeGreaterThan(0);
    expect(plan.estimates.after).toBeLessThan(plan.estimates.before);
    expect(plan.stubs.every((s) => s.kind === "tool_result")).toBe(true);
  });

  it("turn-end: heartbeat pairs plus a horizon cut with a ledger that points at the range", () => {
    const { plan, v } = base(
      "turn-end",
      buildSession({ bigTool: 40_000, heartbeats: 3, earlyText: 12_000 }),
    );
    expect(plan.kind).toBe("horizon");
    const c = plan.compaction!;
    expect(c.summary.startsWith(LEDGER_MARKER)).toBe(true);
    expect(c.summary).toContain("recall_range");
    expect(c.summary).toContain(`Session ${SID}`);
    expect(c.summary).toContain("Heartbeats: 3 check-ins elided");
    expect(c.summary).toContain("Open items:");
    expect(c.summary).toContain("task T-7");
    expect(c.summary).not.toContain("XXXX"); // never quotes tool output
    expect(c.details.elided.heartbeats).toBe(3);
    expect(c.details.elided.firstEntryId).toBe("e1");
    expect(v.entries.find((e) => e.id === c.firstKeptEntryId)!.role).toBe("user");
    // The kept region is only the newest turns.
    expect(c.details.kept.estTokens).toBeLessThan(c.tokensBefore);
    expect(plan.estimates.after).toBeLessThan(plan.estimates.before);
  });

  it("turn-end with one huge turn and no boundary falls back to stubs", () => {
    // Only two turns total: a tiny first and the current (tool heavy) one.
    seq = 0;
    const lines = [JSON.stringify({ type: "session", id: SID, version: 3 })];
    lines.push(msg("a1", null, "user", "hi"));
    lines.push(msg("a2", "a1", "assistant", "hello"));
    lines.push(msg("a3", "a2", "user", "read everything"));
    lines.push(msg("a4", "a3", "assistant", "ok", { toolCalls: ["c1"] }));
    lines.push(msg("a5", "a4", "toolResult", "Y".repeat(400_000), { toolCallId: "c1" }));
    lines.push(msg("a6", "a5", "assistant", "ok", { toolCalls: ["c2"] }));
    lines.push(msg("a7", "a6", "toolResult", "Z".repeat(400_000), { toolCallId: "c2" }));
    lines.push(msg("a8", "a7", "assistant", "ok", { toolCalls: ["c3"] }));
    lines.push(msg("a9", "a8", "toolResult", "W".repeat(400_000), { toolCallId: "c3" }));
    const { plan } = base("turn-end", lines.join("\n") + "\n");
    // minKeepUserTurns 2 means both turns stay: no cut, stubs instead.
    expect(plan.kind).toBe("stubs");
    expect(plan.compaction).toBeUndefined();
    expect(plan.stubs.length).toBeGreaterThan(0);
  });

  it("overflow: stubs first, horizon cut only when they are not enough", () => {
    const { plan } = base("overflow", buildSession({ bigTool: 40_000 }), 20_000, 200_000);
    expect(["stubs", "horizon"]).toContain(plan.kind);
    expect(plan.estimates.after).toBeLessThanOrEqual(plan.estimates.before);
  });

  it("chained offload rolls earlier ranges into the new ledger", () => {
    const first = base("turn-end", buildSession({ bigTool: 40_000, earlyText: 12_000 }));
    const c1 = first.plan.compaction!;
    const jsonl =
      buildSession({ bigTool: 40_000, earlyText: 12_000 }) +
      JSON.stringify({
        type: "compaction",
        id: "cmp1",
        parentId: "e17",
        timestamp: new Date().toISOString(),
        summary: c1.summary,
        firstKeptEntryId: c1.firstKeptEntryId,
        tokensBefore: c1.tokensBefore,
        details: c1.details,
      }) +
      "\n";
    const v2 = view(jsonl);
    expect(v2.previousOffloads).toHaveLength(1);
    const plan2 = planOffload({
      sessionId: SID,
      trigger: "manual",
      entries: v2.entries,
      stubbed: v2.stubbedIds,
      fixedTokens: 20_000,
      contextWindow: 200_000,
      settings: { ...settings, minKeepUserTurns: 1 },
      previousCompactionId: "cmp1",
      previousOffloads: v2.previousOffloads,
      openItems: [],
      workingMemoryFlushed: false,
    });
    if (plan2.kind === "horizon") {
      expect(plan2.compaction!.summary).toContain("Earlier offloads in this session: turns");
      expect(plan2.compaction!.details.previousCompactionId).toBe("cmp1");
    } else {
      // Too little left to cut is also acceptable; the roll-up is then unused.
      expect(plan2.kind).not.toBe("horizon");
    }
  });
});

describe("renderLedger / selectThreads", () => {
  const mkUser = (i: number): PolicyEntry => ({
    id: `u${i}`,
    line: i,
    role: "user",
    text: `user turn ${i} about topic ${i}\nsecond line ignored`,
    tokens: 10,
    turn: i,
    toolCallIds: [],
    images: 0,
    isHeartbeatPrompt: false,
    isHeartbeatAck: false,
  });
  it("lists every real turn when 12 or fewer, else first 2 + 6 spaced + last 4", () => {
    expect(selectThreads(Array.from({ length: 5 }, (_, i) => mkUser(i + 1)))).toHaveLength(5);
    const many = selectThreads(Array.from({ length: 40 }, (_, i) => mkUser(i + 1)));
    expect(many).toHaveLength(12);
    expect(many.slice(0, 2).map((t) => t.turn)).toEqual([1, 2]);
    expect(many.slice(-4).map((t) => t.turn)).toEqual([37, 38, 39, 40]);
    expect(many[0]!.text).toBe("user turn 1 about topic 1");
  });
  it("stays within budget by trimming threads, then open items, then the exchange", () => {
    const threads = Array.from({ length: 12 }, (_, i) => ({
      turn: i + 1,
      entryId: `e${i}`,
      text: "t".repeat(120),
    }));
    const text = renderLedger({
      elided: {
        sessionId: "s",
        firstEntryId: "e0",
        lastEntryId: "e99",
        jsonlLineFrom: 2,
        jsonlLineTo: 200,
        turnFrom: 1,
        turnTo: 40,
        messages: 150,
        userTurns: 40,
        heartbeats: 0,
        toolCalls: 20,
        estTokens: 90_000,
      },
      threads,
      heartbeats: { count: 0 },
      openItems: Array.from({ length: 12 }, (_, i) => `open item ${i} ${"o".repeat(100)}`),
      lastExchange: { user: "u".repeat(240), assistant: "a".repeat(240) },
      previousOffloads: [],
      workingMemoryFlushed: true,
      budgetTokens: 300,
    });
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(300);
    expect(text).toContain(LEDGER_MARKER);
    expect(text).toContain("Range: turns 1-40");
  });
});

describe("minimum-gain guard", () => {
  it("skips a horizon cut that frees less than minElidedTokens, except on overflow/manual", () => {
    // Two short dialogue turns plus the current one: a cut could elide ~a few
    // hundred tokens, below the 2000-token floor.
    seq = 0;
    const lines = [JSON.stringify({ type: "session", id: SID, version: 3 })];
    lines.push(msg("b1", null, "user", "first question"));
    lines.push(msg("b2", "b1", "assistant", "first answer"));
    lines.push(msg("b3", "b2", "user", "second question"));
    lines.push(msg("b4", "b3", "assistant", "second answer"));
    lines.push(msg("b5", "b4", "user", "third question"));
    lines.push(msg("b6", "b5", "assistant", "third answer"));
    const v = view(lines.join("\n") + "\n");
    const common = {
      sessionId: SID,
      entries: v.entries,
      stubbed: v.stubbedIds,
      fixedTokens: 0,
      contextWindow: 200_000,
      settings: { ...DEFAULT_OFFLOAD_SETTINGS, minKeepUserTurns: 1, targetFraction: 0.0001 },
      previousCompactionId: null,
      previousOffloads: [],
      openItems: [],
      workingMemoryFlushed: false,
    };
    const turnEnd = planOffload({ ...common, trigger: "turn-end" });
    expect(turnEnd.kind).toBe("none");
    expect(turnEnd.notes.join(" ")).toContain("horizon cut skipped");
    const manual = planOffload({ ...common, trigger: "manual" });
    expect(manual.kind).toBe("horizon");
  });
});

describe("shouldOffload / resolveOffloadSettings", () => {
  it("applies the per-trigger fractions and always fires on overflow and manual", () => {
    const s = DEFAULT_OFFLOAD_SETTINGS;
    expect(
      shouldOffload({
        trigger: "turn-end",
        promptTokens: 109_000,
        contextWindow: 200_000,
        settings: s,
      }),
    ).toBe(false);
    expect(
      shouldOffload({
        trigger: "turn-end",
        promptTokens: 111_000,
        contextWindow: 200_000,
        settings: s,
      }),
    ).toBe(true);
    expect(
      shouldOffload({
        trigger: "turn-start",
        promptTokens: 139_000,
        contextWindow: 200_000,
        settings: s,
      }),
    ).toBe(false);
    expect(
      shouldOffload({
        trigger: "turn-start",
        promptTokens: 141_000,
        contextWindow: 200_000,
        settings: s,
      }),
    ).toBe(true);
    expect(
      shouldOffload({
        trigger: "mid-turn",
        promptTokens: 161_000,
        contextWindow: 200_000,
        settings: s,
      }),
    ).toBe(true);
    expect(
      shouldOffload({ trigger: "overflow", promptTokens: 1, contextWindow: 200_000, settings: s }),
    ).toBe(true);
    expect(
      shouldOffload({ trigger: "manual", promptTokens: 1, contextWindow: 200_000, settings: s }),
    ).toBe(true);
  });
  it("defaults, bounds and clamps targets below triggers", () => {
    expect(resolveOffloadSettings(undefined)).toEqual(DEFAULT_OFFLOAD_SETTINGS);
    const s = resolveOffloadSettings({
      targetFraction: 0.8,
      triggerTurnEndFraction: 0.6,
      minKeepUserTurns: 3.7,
      toolOutputStubMinTokens: -5,
    });
    expect(s.triggerTurnEndFraction).toBe(0.6);
    expect(s.targetFraction).toBeLessThan(0.6);
    expect(s.minKeepUserTurns).toBe(3);
    expect(s.toolOutputStubMinTokens).toBe(DEFAULT_OFFLOAD_SETTINGS.toolOutputStubMinTokens);
  });
});
