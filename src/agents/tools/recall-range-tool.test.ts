/**
 * PLAN-52A recall_range: deterministic transcript reader with entry / turn /
 * line addressing, branch-path filtering, tool outputs, and the decision-11
 * privacy gate (current session only unless config + owner).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import {
  readTranscriptRows,
  resolveBranchPathIds,
  type SessionTranscriptMessage,
} from "../rlm/context-builder.js";
import {
  createRecallRangeTool,
  parseTurnsParam,
  RECALL_RANGE_MULTI_TOOL_MAX_CHARS,
  renderTranscriptRows,
  resolveRecallCrossSessionMode,
  resolveRecallRangeSession,
  selectTranscriptRows,
} from "./recall-range-tool.js";

const AGENT = "recallrange";
const SID = "33333333-aaaa-4bbb-8ccc-000000000003";
const OTHER = "44444444-aaaa-4bbb-8ccc-000000000004";

function entry(
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-03T10:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 1756900800000, ...extra },
  });
}

let tempRoot: string;
const prevStateDir = process.env.BITTERBOT_STATE_DIR;
const BIG = "B".repeat(RECALL_RANGE_MULTI_TOOL_MAX_CHARS + 300);

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bb-recall-range-"));
  process.env.BITTERBOT_STATE_DIR = tempRoot;
  const dir = path.join(tempRoot, "agents", AGENT, "sessions");
  await fs.mkdir(dir, { recursive: true });
  // Branch: a1 -> a2 -> a3(tool) -> a4 -> a5 -> a6 ; plus an abandoned fork
  // x1 whose parent is a2 and which is NOT on the path from the leaf (a6).
  await fs.writeFile(
    path.join(dir, `${SID}.jsonl`),
    [
      JSON.stringify({ type: "session", id: SID, version: 3 }), // L1
      entry("a1", null, "user", "turn one: read the config"), // L2 t1
      entry("a2", "a1", "assistant", "reading"), // L3
      entry("x1", "a2", "assistant", "FORKED BRANCH text never shown"), // L4 off-path
      entry("a3", "a2", "toolResult", `DATABASE_URL=postgres://x ${BIG}`, {
        toolCallId: "c1",
        toolName: "read",
      }), // L5
      entry("a4", "a3", "assistant", "the config has a database url"), // L6
      entry("a5", "a4", "user", "turn two: now deploy"), // L7 t2
      entry("a6", "a5", "assistant", "deployed"), // L8
    ].join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(dir, `${OTHER}.jsonl`),
    [
      JSON.stringify({ type: "session", id: OTHER, version: 3 }),
      entry("o1", null, "user", "OTHER SESSION secret plans"),
    ].join("\n") + "\n",
  );
});

afterAll(async () => {
  if (prevStateDir === undefined) {
    delete process.env.BITTERBOT_STATE_DIR;
  } else {
    process.env.BITTERBOT_STATE_DIR = prevStateDir;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("resolveBranchPathIds", () => {
  it("walks leaf to root and excludes abandoned forks; null without ids", () => {
    const ids = resolveBranchPathIds([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "x", parentId: "a" },
      { id: "c", parentId: "b" },
    ]);
    expect([...ids!].toSorted()).toEqual(["a", "b", "c"]);
    expect(resolveBranchPathIds([{}, {}])).toBeNull();
  });
});

describe("readTranscriptRows", () => {
  it("returns path rows with turn ordinals, lines and full tool text", async () => {
    const read = await readTranscriptRows(AGENT, SID);
    expect(read?.sessionId).toBe(SID);
    const rows = read!.rows;
    expect(rows.map((r) => r.entryId)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);
    expect(rows.map((r) => r.turn)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(rows.map((r) => r.line)).toEqual([2, 3, 5, 6, 7, 8]);
    const tool = rows.find((r) => r.role === "tool")!;
    expect(tool.toolName).toBe("read");
    expect(tool.text).toContain(BIG); // not truncated at read time
    expect(await readTranscriptRows(AGENT, "missing")).toBeNull();
  });
});

describe("parseTurnsParam", () => {
  it("parses single turns and inclusive ranges, rejects junk", () => {
    expect(parseTurnsParam("5")).toEqual({ from: 5, to: 5 });
    expect(parseTurnsParam(" 3 - 7 ")).toEqual({ from: 3, to: 7 });
    expect(parseTurnsParam("7-3")).toBeUndefined();
    expect(parseTurnsParam("0")).toBeUndefined();
    expect(parseTurnsParam("a-b")).toBeUndefined();
    expect(parseTurnsParam(undefined)).toBeUndefined();
  });
});

describe("resolveRecallRangeSession", () => {
  it("always allows the current session, even for non-owners", () => {
    expect(
      resolveRecallRangeSession({ current: SID, senderIsOwner: false, crossSession: "off" }),
    ).toEqual({ sessionId: SID });
    expect(
      resolveRecallRangeSession({
        requested: SID,
        current: SID,
        senderIsOwner: false,
        crossSession: "off",
      }),
    ).toEqual({ sessionId: SID });
  });
  it("refuses cross-session when the mode is off, and for non-owners when it is owner", () => {
    const off = resolveRecallRangeSession({
      requested: OTHER,
      current: SID,
      senderIsOwner: true,
      crossSession: "off",
    });
    expect("error" in off && off.error).toContain("disabled");
    const nonOwner = resolveRecallRangeSession({
      requested: OTHER,
      current: SID,
      senderIsOwner: false,
      crossSession: "owner",
    });
    expect("error" in nonOwner && nonOwner.error).toContain("owner senders");
  });
  it("allows cross-session for owners when the mode is owner", () => {
    expect(
      resolveRecallRangeSession({
        requested: OTHER,
        current: SID,
        senderIsOwner: true,
        crossSession: "owner",
      }),
    ).toEqual({ sessionId: OTHER });
  });
  it("errors when no session id is known at all", () => {
    const r = resolveRecallRangeSession({ senderIsOwner: true, crossSession: "owner" });
    expect("error" in r).toBe(true);
  });
  it("reads the mode from config, defaulting to off", () => {
    expect(resolveRecallCrossSessionMode(undefined)).toBe("off");
    expect(
      resolveRecallCrossSessionMode({
        agents: { defaults: { compaction: { offload: { recallCrossSession: "owner" } } } },
      } as BitterbotConfig),
    ).toBe("owner");
  });
});

describe("selectTranscriptRows / renderTranscriptRows", () => {
  const rows: SessionTranscriptMessage[] = [
    { role: "user", text: "alpha", line: 2, entryId: "a1", turn: 1 },
    { role: "tool", text: "T".repeat(3000), line: 5, entryId: "a3", turn: 1, toolName: "read" },
    { role: "user", text: "Beta thing", line: 7, entryId: "a5", turn: 2 },
  ];
  it("filters by turns, grep (regex and literal fallback) and tool inclusion", () => {
    expect(
      selectTranscriptRows(rows, { turns: { from: 2, to: 2 }, includeToolResults: true }).map(
        (r) => r.entryId,
      ),
    ).toEqual(["a5"]);
    expect(
      selectTranscriptRows(rows, { grep: "^beta", includeToolResults: true }).map((r) => r.entryId),
    ).toEqual(["a5"]);
    expect(
      selectTranscriptRows(rows, { grep: "beta(", includeToolResults: true }), // invalid regex
    ).toHaveLength(0);
    expect(selectTranscriptRows(rows, { includeToolResults: false }).map((r) => r.entryId)).toEqual(
      ["a1", "a5"],
    );
  });
  it("renders addresses, caps tool outputs when several rows return, keeps one row whole", () => {
    const multi = renderTranscriptRows(rows, 20_000);
    expect(multi.returned).toBe(3);
    expect(multi.text).toContain("[ea1 L2 t1 ");
    expect(multi.text).toContain("TOOL(read)");
    expect(multi.text).toContain("tool output truncated");
    expect(multi.text).not.toContain("T".repeat(2500));
    const single = renderTranscriptRows([rows[1]!], 20_000);
    expect(single.text).toContain("T".repeat(3000));
    expect(single.truncated).toBe(false);
  });
  it("respects max_chars with an omission marker", () => {
    const r = renderTranscriptRows(rows, 120);
    expect(r.returned).toBeLessThan(3);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.text).toContain("omitted");
    expect(r.text.length).toBeLessThan(420);
  });
});

describe("createRecallRangeTool (end to end on fixtures)", () => {
  const cfg = {
    agents: { defaults: { compaction: { offload: { recallCrossSession: "owner" } } } },
  } as BitterbotConfig;
  const make = (senderIsOwner: boolean, configOverride?: BitterbotConfig) =>
    createRecallRangeTool({
      config: configOverride ?? cfg,
      agentSessionKey: `agent:${AGENT}:main`,
      agentSessionId: SID,
      senderIsOwner,
    })!;
  const parse = (res: unknown) => {
    const content = (res as { content: Array<{ text: string }> }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  };

  it("returns the full tool output for a single entry and omits forked branches", async () => {
    const out = parse(await make(false).execute("t", { entries: { from: "a3", to: "a3" } }));
    expect(out.matched).toBe(1);
    expect(String(out.text)).toContain("DATABASE_URL");
    expect(String(out.text)).toContain(BIG);
    const all = parse(await make(false).execute("t", {}));
    expect(all.pathEntries).toBe(6);
    expect(String(all.text)).not.toContain("FORKED BRANCH");
    expect(String(all.text)).toContain("[ea5 L7 t2 ");
  });

  it("returns a stubbed tool output in full by tool_call_id", async () => {
    const out = parse(await make(false).execute("t", { tool_call_id: "c1" }));
    expect(out.matched).toBe(1);
    expect(String(out.text)).toContain("TOOL(read)");
    expect(String(out.text)).toContain(BIG);
    const none = parse(await make(false).execute("t", { tool_call_id: "nope" }));
    expect(none.matched).toBe(0);
  });

  it("selects by turns and lines", async () => {
    const t2 = parse(await make(false).execute("t", { turns: "2" }));
    expect(String(t2.text)).toContain("now deploy");
    expect(String(t2.text)).not.toContain("turn one");
    const l = parse(await make(false).execute("t", { lines: { from: 2, to: 3 } }));
    expect(l.matched).toBe(2);
  });

  it("gates cross-session reads: owner + config only", async () => {
    const denied = parse(await make(false).execute("t", { session_id: OTHER }));
    expect(String(denied.error)).toContain("owner senders");
    const off = parse(
      await make(true, { agents: { defaults: {} } } as BitterbotConfig).execute("t", {
        session_id: OTHER,
      }),
    );
    expect(String(off.error)).toContain("disabled");
    const allowed = parse(await make(true).execute("t", { session_id: OTHER }));
    expect(String(allowed.text)).toContain("OTHER SESSION");
  });

  it("reports an unknown session plainly", async () => {
    const out = parse(await make(true).execute("t", { session_id: "nope" }));
    expect(String(out.error)).toContain("No transcript found");
  });
});
