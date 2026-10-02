/**
 * PLAN-52 Phase 1: differential tests, TranscriptStore vs pi's SessionManager.
 *
 * The same operations run against both on separate copies of the same file;
 * files and read results are compared after normalizing random ids and
 * timestamps. Key order is part of the comparison (lines are compared as
 * strings). This file goes away with the pi-coding-agent dependency (Phase 5);
 * `store.test.ts` holds the tests that stay.
 *
 * Optional: BITTERBOT_TRANSCRIPT_CORPUS=<dir> compares every *.jsonl under
 * that directory (copies are opened, the originals are never touched).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "./store.js";

type Store = TranscriptStore;
const ID_KEYS = new Set(["id", "parentId", "firstKeptEntryId", "targetId", "fromId"]);

/** Deep copy with ids renamed in order of first appearance and timestamps blanked. */
function normalize(value: unknown, ids = new Map<string, string>()): unknown {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && ID_KEYS.has(key) && v !== "root") {
        if (!ids.has(v)) {
          ids.set(v, `#${ids.size}`);
        }
        return ids.get(v);
      }
      if (key === "timestamp" || key === "labelTimestamp") {
        return "TS";
      }
      if (key === "parentSession") {
        return "PARENT";
      }
      return v;
    }
    if (typeof v === "number" && key === "timestamp") {
      return 0;
    }
    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        out[k] = walk(child, k);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Normalized lines of a transcript file; unparseable lines are kept verbatim. */
function fileLines(file: string): string[] | null {
  if (!fs.existsSync(file)) {
    return null;
  }
  const ids = new Map<string, string>();
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.stringify(normalize(JSON.parse(line), ids));
      } catch {
        return `RAW:${line}`;
      }
    });
}

/** Everything a reader can observe, normalized with one shared id table. */
function snapshot(sm: Store) {
  const ids = new Map<string, string>();
  const n = (v: unknown) => JSON.stringify(normalize(v, ids));
  return {
    header: n(sm.getHeader()),
    entries: n(sm.getEntries()),
    leafId: n({ id: sm.getLeafId() }),
    leafEntry: n(sm.getLeafEntry() ?? null),
    branch: n(sm.getBranch()),
    context: n(sm.buildSessionContext()),
    tree: n(sm.getTree()),
    name: sm.getSessionName(),
    sessionId: n({ id: sm.getSessionId() }),
  };
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-test",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  stopReason: "stop",
  timestamp: 2,
});
const toolResult = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

const HEADER =
  '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w"}';
const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, message: unknown) =>
  line({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message });

describe("TranscriptStore vs pi SessionManager", () => {
  let root: string;
  let piFile: string;
  let ourFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-transcript-"));
    fs.mkdirSync(path.join(root, "pi"));
    fs.mkdirSync(path.join(root, "ours"));
    piFile = path.join(root, "pi", "s.jsonl");
    ourFile = path.join(root, "ours", "s.jsonl");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(content: string | null) {
    if (content !== null) {
      fs.writeFileSync(piFile, content);
      fs.writeFileSync(ourFile, content);
    }
  }
  function openBoth(): { pi: Store; ours: Store } {
    return {
      pi: SessionManager.open(piFile, undefined, "/w") as unknown as Store,
      ours: TranscriptStore.open(ourFile, undefined, "/w"),
    };
  }
  /** Run ops on both, then require identical files and identical read results. */
  function same(content: string | null, ops: (sm: Store) => void) {
    seed(content);
    const { pi, ours } = openBoth();
    ops(pi);
    ops(ours);
    expect(fileLines(ourFile)).toEqual(fileLines(piFile));
    expect(snapshot(ours)).toEqual(snapshot(pi));
    // A fresh reader of each file agrees too.
    if (fs.existsSync(piFile)) {
      const reopened = openBoth();
      expect(snapshot(reopened.ours)).toEqual(snapshot(reopened.pi));
    }
    return { pi, ours };
  }

  it("missing file: nothing on disk until the first assistant message", () => {
    seed(null);
    const { pi, ours } = openBoth();
    for (const sm of [pi, ours]) {
      sm.appendMessage(user("hi"));
      sm.appendCustomEntry("note", { a: 1 });
    }
    expect(fs.existsSync(piFile)).toBe(false);
    expect(fs.existsSync(ourFile)).toBe(false);
    for (const sm of [pi, ours]) {
      sm.appendMessage(assistant("hello"));
    }
    expect(fileLines(ourFile)).toEqual(fileLines(piFile));
    expect(fileLines(ourFile)).toHaveLength(4);
    expect(snapshot(ours)).toEqual(snapshot(pi));
  });

  it("every append kind writes the same bytes in the same key order", () => {
    same(null, (sm) => {
      const u1 = sm.appendMessage(user("one"));
      const a1 = sm.appendMessage(assistant("two"));
      sm.appendThinkingLevelChange("high");
      sm.appendModelChange("anthropic", "claude-other");
      sm.appendCustomEntry("bare");
      sm.appendCustomEntry("with-data", { k: [1, 2] });
      sm.appendCustomMessageEntry("cm", "text content", true);
      sm.appendCustomMessageEntry("cm", [{ type: "text", text: "x" }], false, { d: 1 });
      sm.appendSessionInfo("  My session  ");
      sm.appendLabelChange(u1, "first");
      sm.appendLabelChange(u1, "renamed");
      sm.appendLabelChange(a1, "answer");
      sm.appendLabelChange(a1, undefined);
      sm.appendMessage(toolResult("call-1", "output"));
      sm.appendCompaction("summary text", a1, 1234);
      sm.appendCompaction("summary 2", a1, 99, { readFiles: ["a"] }, true);
      sm.appendMessage(user("after"));
      sm.appendMessage(assistant("done"));
    });
  });

  it("session name: last session_info wins, whitespace-only reads as undefined", () => {
    const { ours } = same(null, (sm) => {
      sm.appendMessage(user("u"));
      sm.appendMessage(assistant("a"));
      sm.appendSessionInfo("named");
      sm.appendSessionInfo("   ");
    });
    expect(ours.getSessionName()).toBeUndefined();
  });

  it("branching: siblings, resetLeaf, branch summaries", () => {
    same(null, (sm) => {
      const u1 = sm.appendMessage(user("root question"));
      const a1 = sm.appendMessage(assistant("answer 1"));
      sm.appendMessage(user("follow up"));
      sm.appendMessage(assistant("answer 2"));
      sm.branch(a1);
      sm.appendMessage(user("sibling follow up"));
      sm.appendMessage(assistant("sibling answer"));
      sm.branchWithSummary(u1, "what happened on the other branch", { x: 1 }, true);
      sm.appendMessage(assistant("after summary"));
      sm.branchWithSummary(null, "from the root");
      sm.branchWithSummary(a1, "");
      sm.resetLeaf();
      sm.appendMessage(user("new root"));
      sm.appendMessage(assistant("new root answer"));
    });
  });

  it("read results agree at every leaf of a branched file", () => {
    seed(null);
    const { pi, ours } = openBoth();
    const idsPi: string[] = [];
    const idsOurs: string[] = [];
    const build = (sm: Store, ids: string[]) => {
      ids.push(sm.appendMessage(user("q1")));
      ids.push(sm.appendMessage(assistant("a1")));
      ids.push(sm.appendMessage(user("q2")));
      ids.push(sm.appendCompaction("cut", ids[2]!, 500));
      ids.push(sm.appendMessage(assistant("a2")));
      sm.branch(ids[1]!);
      ids.push(sm.appendMessage(user("q2b")));
      ids.push(sm.appendMessage(assistant("a2b")));
    };
    build(pi, idsPi);
    build(ours, idsOurs);
    for (let i = 0; i < idsPi.length; i++) {
      pi.branch(idsPi[i]!);
      ours.branch(idsOurs[i]!);
      expect(snapshot(ours)).toEqual(snapshot(pi));
      expect(JSON.stringify(normalize(ours.getChildren(idsOurs[i]!)))).toEqual(
        JSON.stringify(normalize(pi.getChildren(idsPi[i]!))),
      );
    }
    pi.resetLeaf();
    ours.resetLeaf();
    expect(snapshot(ours)).toEqual(snapshot(pi));
    expect(ours.buildSessionContext().messages).toEqual([]);
  });

  it("existing files: header only then assistant; header + user then assistant", () => {
    same(`${HEADER}\n`, (sm) => {
      sm.appendMessage(assistant("first line appended"));
      sm.appendMessage(user("next"));
    });
    fs.rmSync(piFile);
    fs.rmSync(ourFile);
    same(`${HEADER}\n${msg("u1", null, user("hi"))}\n`, (sm) => {
      sm.appendMessage(assistant("reply"));
      sm.appendCustomEntry("after");
    });
  });

  it("tolerates CRLF, a BOM, blank lines, and a malformed line mid-file", () => {
    const body = [
      HEADER,
      msg("u1", null, user("hi")),
      "{not json",
      "",
      msg("a1", "u1", assistant("yo")),
      "",
      "",
    ].join("\r\n");
    same(`﻿${body}`, (sm) => {
      sm.appendMessage(user("again"));
      sm.appendMessage(assistant("still here"));
    });
    // The malformed line is still on disk after appends.
    expect(fs.readFileSync(ourFile, "utf8")).toContain("{not json");
  });

  it("unknown entry types are kept, can be the leaf, and are ignored by the context", () => {
    const content = [
      HEADER,
      msg("u1", null, user("hi")),
      msg("a1", "u1", assistant("yo")),
      line({
        type: "future_thing",
        id: "f1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        x: 1,
      }),
    ].join("\n");
    const { ours } = same(`${content}\n`, () => {});
    expect(ours.getLeafId()).toBe("f1");
    same(null, () => {});
    fs.writeFileSync(piFile, `${content}\n`);
    fs.writeFileSync(ourFile, `${content}\n`);
    same(null, (sm) => {
      sm.appendMessage(user("after unknown"));
      sm.appendMessage(assistant("ok"));
    });
  });

  it("an entry without an id as the last line behaves the same", () => {
    const content = [
      HEADER,
      msg("u1", null, user("hi")),
      msg("a1", "u1", assistant("yo")),
      line({ type: "custom", customType: "odd", timestamp: "2026-01-01T00:00:02.000Z" }),
    ].join("\n");
    same(`${content}\n`, (sm) => {
      sm.appendMessage(user("next"));
      sm.appendMessage(assistant("ok"));
    });
  });

  it("a file with a second header and duplicated entries reads the same", () => {
    const u = msg("u1", null, user("hi"));
    const content = [HEADER, u, HEADER, u, msg("a1", "u1", assistant("yo"))].join("\n");
    same(`${content}\n`, (sm) => {
      sm.appendMessage(user("more"));
    });
  });

  it("compaction: kept range, missing firstKeptEntryId, two compactions, sibling branch", () => {
    const c = (id: string, parentId: string, firstKeptEntryId: string | undefined) =>
      line({
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:05.000Z",
        summary: `summary ${id}`,
        firstKeptEntryId,
        tokensBefore: 1000,
      });
    const content = [
      HEADER,
      line({
        type: "thinking_level_change",
        id: "t1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.500Z",
        thinkingLevel: "low",
      }),
      msg("u1", "t1", user("q1")),
      msg("a1", "u1", assistant("a1")),
      line({
        type: "model_change",
        id: "m1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        provider: "p",
        modelId: "x",
      }),
      msg("u2", "m1", user("q2")),
      line({
        type: "custom_message",
        customType: "cm",
        content: "injected",
        display: true,
        id: "cm1",
        parentId: "u2",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
      line({
        type: "custom",
        customType: "bitterbot.offload-prune",
        data: { stubs: [] },
        id: "cu1",
        parentId: "cm1",
        timestamp: "2026-01-01T00:00:03.500Z",
      }),
      msg("a2", "cu1", assistant("a2")),
      c("c1", "a2", "u2"),
      msg("u3", "c1", user("q3")),
      msg("a3", "u3", assistant("a3")),
      c("c2", "a3", "u1"),
      msg("u4", "c2", user("q4")),
      c("c3", "u4", "nope"),
      msg("a4", "c3", assistant("a4")),
      c("c4", "a4", undefined),
      msg("u5", "c4", user("q5")),
      // Sibling branch off a2: its compaction must not apply to the main path.
      msg("u3b", "a2", user("q3b")),
      c("c1b", "u3b", "a1"),
      msg("a3b", "c1b", assistant("a3b")),
      c("first", "a3b", "t1"),
    ].join("\n");
    seed(`${content}\n`);
    const { pi, ours } = openBoth();
    for (const leaf of [
      "a2",
      "c1",
      "a3",
      "c2",
      "u4",
      "c3",
      "a4",
      "c4",
      "u5",
      "u3b",
      "a3b",
      "first",
    ]) {
      pi.branch(leaf);
      ours.branch(leaf);
      expect(snapshot(ours), `leaf ${leaf}`).toEqual(snapshot(pi));
    }
  });

  it("migrates v1 and v2 files identically and leaves a future version alone", () => {
    const v1 = [
      line({ type: "session", id: "old", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/w" }),
      line({ type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: user("q") }),
      line({ type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: assistant("a") }),
      line({
        type: "message",
        timestamp: "2025-01-01T00:00:03.000Z",
        message: {
          role: "hookMessage",
          customType: "h",
          content: "x",
          display: true,
          timestamp: 5,
        },
      }),
      line({
        type: "compaction",
        timestamp: "2025-01-01T00:00:04.000Z",
        summary: "s",
        firstKeptEntryIndex: 2,
        tokensBefore: 10,
      }),
      line({ type: "message", timestamp: "2025-01-01T00:00:05.000Z", message: user("q2") }),
    ].join("\n");
    same(`${v1}\n`, () => {});
    expect(fileLines(ourFile)?.[0]).toContain('"version":3');
    expect(fs.readFileSync(ourFile, "utf8")).not.toContain("firstKeptEntryIndex");
    expect(fs.readFileSync(ourFile, "utf8")).not.toContain("hookMessage");

    const v2 = [
      line({
        type: "session",
        version: 2,
        id: "old2",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/w",
      }),
      msg("u1", null, user("q")),
      "garbage line",
      msg("a1", "u1", {
        role: "hookMessage",
        customType: "h",
        content: "x",
        display: true,
        timestamp: 5,
      }),
    ].join("\n");
    same(`${v2}\n`, () => {});
    expect(fs.readFileSync(ourFile, "utf8")).not.toContain("garbage line");

    const v99 = [
      line({
        type: "session",
        version: 99,
        id: "new",
        timestamp: "2027-01-01T00:00:00.000Z",
        cwd: "/w",
      }),
      msg("u1", null, { role: "hookMessage", content: "kept as is" }),
      msg("a1", "u1", assistant("a")),
    ].join("\n");
    same(`${v99}\n`, () => {});
    expect(fs.readFileSync(ourFile, "utf8")).toBe(`${v99}\n`);
  });

  it("createBranchedSession: with an assistant on the path (file written), with labels", () => {
    seed(null);
    const { pi, ours } = openBoth();
    const run = (sm: Store) => {
      const u1 = sm.appendMessage(user("q1"));
      const a1 = sm.appendMessage(assistant("a1"));
      sm.appendLabelChange(a1, "keep me");
      sm.appendLabelChange(u1, "and me");
      const u2 = sm.appendMessage(user("q2"));
      sm.appendLabelChange(u2, "off path");
      sm.appendMessage(assistant("a2"));
      return sm.createBranchedSession(a1);
    };
    const piNew = run(pi)!;
    const oursNew = run(ours)!;
    expect(fileLines(oursNew)).toEqual(fileLines(piNew));
    expect(snapshot(ours)).toEqual(snapshot(pi));
    expect(JSON.parse(fs.readFileSync(oursNew, "utf8").split("\n")[0]!).parentSession).toBe(
      ourFile,
    );
    // Appends continue in the new file.
    pi.appendMessage(user("on the branch"));
    ours.appendMessage(user("on the branch"));
    expect(fileLines(oursNew)).toEqual(fileLines(piNew));
  });

  it("createBranchedSession: no assistant on the path (no file yet), and in memory", () => {
    seed(null);
    const { pi, ours } = openBoth();
    const run = (sm: Store) => {
      const u1 = sm.appendMessage(user("q1"));
      sm.appendMessage(assistant("a1"));
      return sm.createBranchedSession(u1);
    };
    const piNew = run(pi)!;
    const oursNew = run(ours)!;
    expect(fs.existsSync(piNew)).toBe(false);
    expect(fs.existsSync(oursNew)).toBe(false);
    expect(snapshot(ours)).toEqual(snapshot(pi));
    pi.appendMessage(assistant("first assistant on the branch"));
    ours.appendMessage(assistant("first assistant on the branch"));
    expect(fileLines(oursNew)).toEqual(fileLines(piNew));

    const memPi = SessionManager.inMemory("/w") as unknown as Store;
    const memOurs = TranscriptStore.inMemory("/w");
    for (const sm of [memPi, memOurs]) {
      const u = sm.appendMessage(user("q"));
      sm.appendMessage(assistant("a"));
      expect(sm.createBranchedSession(u)).toBeUndefined();
      expect(sm.getSessionFile()).toBeUndefined();
      expect(sm.isPersisted()).toBe(false);
    }
    expect(snapshot(memOurs)).toEqual(snapshot(memPi));
    expect(() => memOurs.createBranchedSession("missing")).toThrow("Entry missing not found");
    expect(() => memPi.createBranchedSession("missing")).toThrow("Entry missing not found");
  });

  it("errors match: unknown ids", () => {
    seed(null);
    const { pi, ours } = openBoth();
    for (const sm of [pi, ours]) {
      expect(() => sm.branch("nope")).toThrow("Entry nope not found");
      expect(() => sm.appendLabelChange("nope", "x")).toThrow("Entry nope not found");
      expect(() => sm.branchWithSummary("nope", "s")).toThrow("Entry nope not found");
    }
  });

  const corpus = process.env.BITTERBOT_TRANSCRIPT_CORPUS;
  it.skipIf(!corpus)(
    "corpus: every real transcript reads the same through both",
    () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith(".jsonl")) {
            files.push(full);
          }
        }
      };
      walk(corpus!);
      let compared = 0;
      const mismatches: string[] = [];
      for (const file of files) {
        if (fs.statSync(file).size > 64 * 1024 * 1024) {
          continue;
        }
        const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
        if (!first.includes('"type":"session"')) {
          continue; // not a transcript, or one pi would wipe; covered by store.test.ts
        }
        fs.copyFileSync(file, piFile);
        fs.copyFileSync(file, ourFile);
        const { pi, ours } = openBoth();
        const a = snapshot(ours);
        const b = snapshot(pi);
        if (
          JSON.stringify(a) !== JSON.stringify(b) ||
          fs.readFileSync(ourFile, "utf8") !== fs.readFileSync(piFile, "utf8")
        ) {
          mismatches.push(file);
        }
        compared++;
      }
      // eslint-disable-next-line no-console
      console.log(`[corpus] compared ${compared} of ${files.length} files`);
      expect(mismatches).toEqual([]);
      expect(compared).toBeGreaterThan(0);
    },
    540_000,
  );
});
