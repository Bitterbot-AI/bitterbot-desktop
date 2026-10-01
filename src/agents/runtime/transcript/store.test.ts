/**
 * PLAN-52 Phase 1: TranscriptStore behaviour that does not need pi to check:
 * the deliberate differences from pi's SessionManager, the on-disk key order,
 * and the seams the rest of the runtime relies on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "../../embedded-runner/session-manager-init.js";
import { buildSessionContext } from "./context.js";
import { migrateToCurrentVersion } from "./migrations.js";
import { createSessionId, loadEntriesFromFile, TranscriptStore } from "./store.js";
import type { TranscriptEntry } from "./types.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  timestamp: 2,
});
const HEADER =
  '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w"}';
const entryLine = (id: string, parentId: string | null, message: unknown) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message,
  });

describe("TranscriptStore", () => {
  let dir: string;
  let file: string;
  const types = () =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const e = JSON.parse(l) as { type: string; message?: { role: string } };
        return e.message?.role ?? e.type;
      });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-store-"));
    file = path.join(dir, "s.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("difference 1: no duplicate header", () => {
    it("header-only file, then user and assistant", () => {
      fs.writeFileSync(file, `${HEADER}\n`);
      const store = TranscriptStore.open(file);
      store.appendMessage(user("hi"));
      expect(types()).toEqual(["session"]);
      store.appendMessage(assistant("hello"));
      expect(types()).toEqual(["session", "user", "assistant"]);
      expect(store.getSessionId()).toBe("sess-1");
    });

    it("header + user file, then custom and assistant", () => {
      fs.writeFileSync(file, `${HEADER}\n${entryLine("u1", null, user("hi"))}\n`);
      const store = TranscriptStore.open(file);
      store.appendCustomEntry("note", { a: 1 });
      store.appendMessage(assistant("hello"));
      expect(types()).toEqual(["session", "user", "custom", "assistant"]);
      const reopened = TranscriptStore.open(file);
      expect(reopened.getBranch().map((e) => e.type)).toEqual(["message", "custom", "message"]);
    });

    it("the legacy flushed=false reset (prepareSessionManagerForRun) still yields one header", async () => {
      fs.writeFileSync(file, `${HEADER}\n${entryLine("u0", null, user("stale"))}\n`);
      const store = TranscriptStore.open(file);
      await prepareSessionManagerForRun({
        sessionManager: store,
        sessionFile: file,
        hadSessionFile: true,
        sessionId: "sess-1",
        cwd: "/w",
      });
      store.appendMessage(user("hi"));
      store.appendMessage(assistant("hello"));
      expect(types()).toEqual(["session", "user", "assistant"]);
    });

    it("a new file takes the header identity set before the first flush", async () => {
      const store = TranscriptStore.open(file);
      await prepareSessionManagerForRun({
        sessionManager: store,
        sessionFile: file,
        hadSessionFile: false,
        sessionId: "our-session-id",
        cwd: "/workspace",
      });
      store.appendMessage(user("hi"));
      store.appendMessage(assistant("hello"));
      const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]!);
      expect(header).toMatchObject({
        type: "session",
        version: 3,
        id: "our-session-id",
        cwd: "/workspace",
      });
      expect(Object.keys(header)).toEqual(["type", "version", "id", "timestamp", "cwd"]);

      const other = TranscriptStore.open(path.join(dir, "t.jsonl"));
      other.setHeaderIdentity({ id: "explicit", cwd: "/elsewhere" });
      expect(other.getSessionId()).toBe("explicit");
      expect(other.getCwd()).toBe("/elsewhere");
      expect(other.getHeader()).toMatchObject({ id: "explicit", cwd: "/elsewhere" });
    });
  });

  describe("difference 2: a damaged file is moved aside, never overwritten", () => {
    for (const [name, content] of [
      [
        "corrupt first line",
        `{"type":"session","id":\n${entryLine("u1", null, user("precious"))}\n`,
      ],
      ["first entry not a header", `${entryLine("u1", null, user("precious"))}\n`],
      [
        "header id not a string",
        `{"type":"session","id":7}\n${entryLine("u1", null, user("precious"))}\n`,
      ],
    ] as const) {
      it(name, () => {
        fs.writeFileSync(file, content);
        const store = TranscriptStore.open(file);
        const aside = fs.readdirSync(dir).filter((f) => f.startsWith("s.jsonl.corrupt."));
        expect(aside).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, aside[0]!), "utf8")).toBe(content);
        expect(fs.existsSync(file)).toBe(false);
        expect(store.getEntries()).toEqual([]);
        store.appendMessage(user("fresh"));
        store.appendMessage(assistant("start"));
        expect(types()).toEqual(["session", "user", "assistant"]);
      });
    }
  });

  it("difference 3: an empty or whitespace-only file is treated as missing", () => {
    for (const content of ["", "  \n\n"]) {
      fs.writeFileSync(file, content);
      const store = TranscriptStore.open(file);
      expect(fs.readFileSync(file, "utf8")).toBe(content);
      store.appendMessage(user("hi"));
      store.appendMessage(assistant("hello"));
      expect(types()).toEqual(["session", "user", "assistant"]);
      fs.rmSync(file);
    }
  });

  it("difference 4: parent cycles terminate", () => {
    const content = [
      HEADER,
      entryLine("a", "c", user("1")),
      entryLine("b", "a", assistant("2")),
      entryLine("c", "b", user("3")),
      entryLine("self", "self", assistant("4")),
    ].join("\n");
    fs.writeFileSync(file, `${content}\n`);
    const store = TranscriptStore.open(file);
    expect(store.getBranch("c").map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(store.getBranch().map((e) => e.id)).toEqual(["self"]);
    expect(store.buildSessionContext().messages).toHaveLength(1);
    store.branch("c");
    expect(store.buildSessionContext().messages).toHaveLength(3);
    expect(store.getTree().length).toBeGreaterThan(0);
  });

  it("writes entries with the documented key order and omits undefined optionals", () => {
    const store = TranscriptStore.open(file);
    const u = store.appendMessage(user("q"));
    const a = store.appendMessage(assistant("a"));
    store.appendThinkingLevelChange("high");
    store.appendModelChange("p", "m");
    store.appendCompaction("s", a, 10);
    store.appendCustomEntry("bare");
    store.appendCustomEntry("bitterbot.offload-prune", { stubs: [] });
    store.appendCustomMessageEntry("cm", "c", true);
    store.appendSessionInfo(" n ");
    store.appendLabelChange(u, undefined);
    store.branchWithSummary(null, "sum");
    const keys = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => Object.keys(JSON.parse(l)).join(","));
    expect(keys).toEqual([
      "type,version,id,timestamp,cwd",
      "type,id,parentId,timestamp,message",
      "type,id,parentId,timestamp,message",
      "type,id,parentId,timestamp,thinkingLevel",
      "type,id,parentId,timestamp,provider,modelId",
      "type,id,parentId,timestamp,summary,firstKeptEntryId,tokensBefore",
      "type,customType,id,parentId,timestamp",
      "type,customType,data,id,parentId,timestamp",
      "type,customType,content,display,id,parentId,timestamp",
      "type,id,parentId,timestamp,name",
      "type,id,parentId,timestamp,targetId",
      "type,id,parentId,timestamp,fromId,summary",
    ]);
    const last = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop()!);
    expect(last).toMatchObject({ parentId: null, fromId: "root" });
    expect(store.getSessionName()).toBe("n");
  });

  it("appendMessage is an overridable instance member and other appends do not route through it", () => {
    const store = TranscriptStore.inMemory("/w");
    const original = store.appendMessage.bind(store);
    const seen: string[] = [];
    store.appendMessage = (message) => {
      seen.push(message.role);
      return original(message);
    };
    store.appendMessage(user("q"));
    store.appendCustomEntry("x");
    store.appendCompaction("s", "none", 1);
    store.appendMessage(assistant("a"));
    expect(seen).toEqual(["user", "assistant"]);
    expect(store.getEntries()).toHaveLength(4);
    // The wrapper adds own properties to the same object.
    (store as unknown as { flushPendingToolResults: () => void }).flushPendingToolResults =
      () => {};
    expect(Object.isExtensible(store)).toBe(true);
  });

  it("in-memory stores never touch the disk", () => {
    const store = TranscriptStore.inMemory("/w");
    store.appendMessage(user("q"));
    store.appendMessage(assistant("a"));
    expect(store.getSessionFile()).toBeUndefined();
    expect(store.getSessionDir()).toBe("");
    expect(store.isPersisted()).toBe(false);
    expect(store.buildSessionContext().messages).toHaveLength(2);
    expect(store.buildSessionContext().model).toEqual({
      provider: "anthropic",
      modelId: "claude-test",
    });
  });

  it("an offload compaction entry (ledger summary) renders as a compactionSummary message", () => {
    const store = TranscriptStore.inMemory("/w");
    store.appendMessage(user("old question"));
    store.appendMessage(assistant("old answer"));
    const kept = store.appendMessage(user("kept question"));
    store.appendMessage(assistant("kept answer"));
    store.appendCompaction("[Context offloaded]\nledger text", kept, 42_000, { policy: "offload" });
    store.appendMessage(user("next"));
    const { messages } = store.buildSessionContext();
    expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "user", "assistant", "user"]);
    expect(messages[0]).toMatchObject({
      summary: "[Context offloaded]\nledger text",
      tokensBefore: 42_000,
    });
  });

  it("helpers: session ids are uuidv7, the loader reports damage, migration is idempotent", () => {
    const id = createSessionId(Date.UTC(2026, 0, 1));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(Date.UTC(2026, 0, 1));
    expect(createSessionId(1) < createSessionId(2 ** 41)).toBe(true);

    expect(loadEntriesFromFile(path.join(dir, "missing.jsonl"))).toEqual({
      entries: [],
      valid: true,
      empty: true,
    });
    fs.writeFileSync(file, "not json\n");
    expect(loadEntriesFromFile(file)).toEqual({ entries: [], valid: false, empty: false });

    const entries = [
      { type: "session", id: "s", timestamp: "t", cwd: "/w" },
      { type: "message", timestamp: "t", message: { role: "hookMessage" } },
    ] as Array<Record<string, unknown>>;
    expect(migrateToCurrentVersion(entries)).toBe(true);
    expect(migrateToCurrentVersion(entries)).toBe(false);
    expect(entries[0]!.version).toBe(3);
    expect((entries[1]!.message as { role: string }).role).toBe("custom");
    expect(
      buildSessionContext(entries.slice(1) as unknown as TranscriptEntry[]).messages,
    ).toHaveLength(1);
  });
});
