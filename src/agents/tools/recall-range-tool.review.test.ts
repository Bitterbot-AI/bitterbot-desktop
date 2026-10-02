/**
 * REVIEW (adversarial pass, PLAN-52A): the offload ledger and the tool-output
 * stubs promise "nothing is lost, recall_range returns it". Each test here is
 * a case where recall_range cannot keep that promise. They fail on the
 * current code.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import { readTranscriptRows } from "../rlm/context-builder.js";
import { buildTranscriptView, parseJsonl } from "../runtime/compaction/transcript-view.js";
import { TranscriptStore } from "../runtime/transcript/store.js";
import { createRecallRangeTool } from "./recall-range-tool.js";

const AGENT = "recallreview";
const SID = "55555555-aaaa-4bbb-8ccc-000000000005";

function entry(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-03T10:00:00.000Z",
    message: {
      role,
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      timestamp: 1756900800000,
      ...extra,
    },
  });
}

let tempRoot: string;
let dir: string;
const prevStateDir = process.env.BITTERBOT_STATE_DIR;
const HUGE = `HEAD ${"x".repeat(150_000)} TAIL-MARKER-THE-ANSWER-IS-42`;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bb-recall-review-"));
  process.env.BITTERBOT_STATE_DIR = tempRoot;
  dir = path.join(tempRoot, "agents", AGENT, "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${SID}.jsonl`),
    [
      JSON.stringify({ type: "session", id: SID, version: 3 }), // L1
      entry("a1", null, "user", "turn one"), // L2 t1
      entry("a2", "a1", "assistant", "reading"), // L3
      entry("a3", "a2", "toolResult", HUGE, { toolCallId: "big", toolName: "read" }), // L4
      entry("a4", "a3", "assistant", "screenshot next"), // L5
      entry("a5", "a4", "toolResult", [{ type: "image", data: "AAAA", mimeType: "image/png" }], {
        toolCallId: "shot",
        toolName: "browser",
      }), // L6
      entry("a6", "a5", "assistant", "done"), // L7
      // A user message with an image and no text (turn 2 for the planner).
      entry("a7", "a6", "user", [{ type: "image", data: "AAAA", mimeType: "image/png" }]), // L8
      entry("a8", "a7", "assistant", "nice picture"), // L9
      entry("a9", "a8", "user", "turn three: the deploy question"), // L10
      entry("b1", "a9", "assistant", "calling"), // L11
      // A provider that reuses call ids per turn ("call_0").
      entry("b2", "b1", "toolResult", `first ${"f".repeat(5_000)}`, {
        toolCallId: "call_0",
        toolName: "exec",
      }), // L12
      entry("b3", "b2", "user", "turn four"), // L13
      entry("b4", "b3", "assistant", "calling again"), // L14
      entry("b5", "b4", "toolResult", `second ${"s".repeat(5_000)} SECOND-TAIL`, {
        toolCallId: "call_0",
        toolName: "exec",
      }), // L15
      entry("b6", "b5", "assistant", "end"), // L16
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

const cfg = {} as BitterbotConfig;
const make = (sessionId: string) =>
  createRecallRangeTool({
    config: cfg,
    agentSessionKey: `agent:${AGENT}:main`,
    agentSessionId: sessionId,
    senderIsOwner: true,
  })!;
const parse = (res: unknown) => {
  const content = (res as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

describe("REVIEW recall_range cannot return everything a stub or ledger points at", () => {
  it("a stubbed tool output larger than max_chars (cap 60k, store cap 400k) is only reachable up to the cap", async () => {
    // The stub says: "[tool output offloaded: read, 150,034 chars; full text:
    // recall_range tool_call_id big]". There is no offset parameter.
    const out = parse(await make(SID).execute("t", { tool_call_id: "big", max_chars: 60_000 }));
    expect(out.matched).toBe(1);
    expect(String(out.text)).toContain("TAIL-MARKER-THE-ANSWER-IS-42");
  });

  it("a stubbed image-only tool result returns nothing", async () => {
    const out = parse(await make(SID).execute("t", { tool_call_id: "shot" }));
    expect(out.matched).toBe(1);
  });

  it("a reused tool call id returns both outputs capped at 2k instead of the full text", async () => {
    const out = parse(await make(SID).execute("t", { tool_call_id: "call_0" }));
    expect(String(out.text)).toContain("SECOND-TAIL");
  });

  it("an entry id copied from the ledger's thread list (e<id>) silently returns the whole transcript", async () => {
    // Ledger line: `  t3 ea9  "turn three: the deploy question"`, legend
    // "e = entry id". Ids are hex, so the model cannot tell the prefix apart.
    const out = parse(await make(SID).execute("t", { entries: { from: "ea9", to: "ea9" } }));
    // Either resolve it or say it is unknown; do not return unrelated rows.
    expect(out.matched === 1 || out.matched === 0 || typeof out.error === "string").toBe(true);
  });

  it("turn ordinals in the ledger (planner view) and in recall_range disagree after a text-less user message", async () => {
    const raw = await fs.readFile(path.join(dir, `${SID}.jsonl`), "utf8");
    const view = buildTranscriptView({
      records: parseJsonl(raw),
      sessionIdFallback: SID,
      heartbeatPrompts: [],
    });
    const plannerTurn = view.allEntries.find((e) => e.id === "a9")!.turn;
    const rows = (await readTranscriptRows(AGENT, SID))!.rows;
    const recallTurn = rows.find((r) => r.entryId === "a9")!.turn;
    expect(recallTurn).toBe(plannerTurn);
  });

  it("a forum-topic session file (<sessionId>-topic-<n>.jsonl) cannot be read at all", async () => {
    const topicSid = "66666666-aaaa-4bbb-8ccc-000000000006";
    const file = resolveSessionTranscriptPathInDir(topicSid, dir, 42);
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "session", id: topicSid, version: 3 }),
        entry("t1", null, "user", "topic question"),
        entry("t2", "t1", "assistant", "topic answer"),
      ].join("\n") + "\n",
    );
    const out = parse(await make(topicSid).execute("t", { grep: "topic" }));
    expect(out.error).toBeUndefined();
    expect(out.matched).toBe(2);
  });

  it("a forked thread session (<timestamp>_<uuid>.jsonl, what createBranchedSession writes) cannot be read at all", async () => {
    const parent = TranscriptStore.open(path.join(dir, "parent-for-fork.jsonl"));
    parent.appendMessage({ role: "user", content: [{ type: "text", text: "fork me" }] });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "forked answer" }],
      provider: "p",
      model: "m",
    });
    const forkedFile = parent.createBranchedSession(parent.getLeafId()!)!;
    const forkedId = parent.getSessionId(); // what forkSessionFromParent stores as sessionId
    expect(await fs.stat(forkedFile).then(() => true)).toBe(true);
    const out = parse(await make(forkedId).execute("t", { grep: "fork" }));
    expect(out.error).toBeUndefined();
    expect(out.matched).toBe(2);
  });
});
