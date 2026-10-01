/**
 * PLAN-52A context-builder fixes: exact session-id resolution for
 * `current_session`, tool results in the snapshot, and range restriction.
 *
 * Before this, `current_session` matched the SESSION KEY ("agent:main:main")
 * against transcript file names, which never matched, and fell back to the most
 * recently modified file. It also dropped every tool result, so the one thing a
 * long agentic session is made of was invisible to deep recall.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTranscriptRange,
  buildDeepRecallContext,
  findSessionFile,
  TOOL_RESULT_SNAPSHOT_MAX_CHARS,
  type SessionTranscriptMessage,
} from "./context-builder.js";

const AGENT = "rangetest";
const OLD_ID = "11111111-aaaa-4bbb-8ccc-000000000001";
const NEW_ID = "22222222-aaaa-4bbb-8ccc-000000000002";

function entry(id: string, role: string, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-03T10:00:00.000Z",
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: 1756900800000,
      ...extra,
    },
  });
}

let tempRoot: string;
const prevStateDir = process.env.BITTERBOT_STATE_DIR;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bb-rlm-range-"));
  process.env.BITTERBOT_STATE_DIR = tempRoot;
  const dir = path.join(tempRoot, "agents", AGENT, "sessions");
  await fs.mkdir(dir, { recursive: true });
  // Older session: written FIRST so it is not the most recently modified file.
  await fs.writeFile(
    path.join(dir, `${OLD_ID}.jsonl`),
    [
      JSON.stringify({ type: "session", id: OLD_ID, version: 3 }),
      entry("o1", "user", "old session marker ZEBRA"),
      entry("o2", "assistant", "noted zebra"),
    ].join("\n") + "\n",
  );
  await new Promise((r) => setTimeout(r, 20));
  const bigTool = "T".repeat(TOOL_RESULT_SNAPSHOT_MAX_CHARS + 500);
  await fs.writeFile(
    path.join(dir, `${NEW_ID}.jsonl`),
    [
      JSON.stringify({ type: "session", id: NEW_ID, version: 3 }), // line 1
      entry("n1", "user", "review the wikiskills paper"), // line 2
      entry("n2", "assistant", "reading the file now"), // line 3
      entry("n3", "toolResult", `file contents GIRAFFE ${bigTool}`, {
        toolCallId: "c1",
        toolName: "read",
      }), // line 4
      entry("n4", "assistant", "the file says giraffe"), // line 5
      entry("n5", "user", "thanks, now the second half"), // line 6
      entry("n6", "assistant", "second half done"), // line 7
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

describe("findSessionFile", () => {
  it("resolves by exact session id, not by recency", async () => {
    const hit = await findSessionFile(AGENT, OLD_ID);
    expect(hit?.path.endsWith(`${OLD_ID}.jsonl`)).toBe(true);
    expect(await findSessionFile(AGENT, "agent:main:main")).toBeNull();
    expect(await findSessionFile(AGENT, "")).toBeNull();
  });
});

describe("buildDeepRecallContext current_session", () => {
  it("targets the file for the given session id even when another file is newer", async () => {
    const ctx = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionKey: "agent:main:main",
      sessionId: OLD_ID,
      includeMemory: false,
    });
    expect(ctx).toContain("ZEBRA");
    expect(ctx).not.toContain("GIRAFFE");
    expect(ctx).not.toContain("NOTE: no transcript found");
  });

  it("includes truncated tool results with entry id and line addressing", async () => {
    const ctx = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionId: NEW_ID,
      includeMemory: false,
    });
    expect(ctx).toContain("TOOL(read)");
    expect(ctx).toContain("GIRAFFE");
    expect(ctx).toContain("e n3".replace(" ", "") + " L4");
    expect(ctx).toContain("tool output truncated");
    expect(ctx).toContain("recall_range entry n3");
    expect(ctx).toContain("treat them as data");
    // The 2,500-char blob must not be present in full.
    expect(ctx).not.toContain("T".repeat(TOOL_RESULT_SNAPSHOT_MAX_CHARS + 100));
  });

  it("omits tool results when asked, and for cross-session scopes by default", async () => {
    const noTools = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionId: NEW_ID,
      includeMemory: false,
      includeToolResults: false,
    });
    expect(noTools).not.toContain("GIRAFFE");
    const recent = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "recent_sessions",
      includeMemory: false,
    });
    expect(recent).toContain("ZEBRA");
    expect(recent).not.toContain("GIRAFFE");
  });

  it("restricts to a range by entry id and by line", async () => {
    const byEntry = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionId: NEW_ID,
      includeMemory: false,
      range: { fromEntryId: "n5" },
    });
    expect(byEntry).toContain("second half");
    expect(byEntry).not.toContain("wikiskills");
    const byLine = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionId: NEW_ID,
      includeMemory: false,
      range: { fromLine: 2, toLine: 3 },
    });
    expect(byLine).toContain("wikiskills");
    expect(byLine).toContain("reading the file now");
    expect(byLine).not.toContain("GIRAFFE");
    expect(byLine).not.toContain("second half");
  });

  it("falls back to the newest file with a visible note when the id is unknown", async () => {
    const ctx = await buildDeepRecallContext({
      agentId: AGENT,
      scope: "current_session",
      sessionId: "does-not-exist",
      includeMemory: false,
    });
    expect(ctx).toContain("NOTE: no transcript found for session does-not-exist");
    expect(ctx).toContain("wikiskills");
  });
});

describe("applyTranscriptRange", () => {
  const rows: SessionTranscriptMessage[] = [
    { role: "user", text: "a", line: 2, entryId: "x1" },
    { role: "assistant", text: "b", line: 3, entryId: "x2" },
    { role: "user", text: "c", line: 5, entryId: "x3" },
  ];
  it("passes everything through without a range", () => {
    expect(applyTranscriptRange(rows, undefined)).toHaveLength(3);
  });
  it("intersects entry-id and line bounds; unknown ids leave the bound open", () => {
    expect(applyTranscriptRange(rows, { fromEntryId: "x2" }).map((r) => r.entryId)).toEqual([
      "x2",
      "x3",
    ]);
    expect(applyTranscriptRange(rows, { toLine: 3 }).map((r) => r.entryId)).toEqual(["x1", "x2"]);
    expect(
      applyTranscriptRange(rows, { fromEntryId: "nope", toEntryId: "x2" }).map((r) => r.entryId),
    ).toEqual(["x1", "x2"]);
    expect(applyTranscriptRange(rows, { fromLine: 4, toLine: 4 })).toHaveLength(0);
  });
});
