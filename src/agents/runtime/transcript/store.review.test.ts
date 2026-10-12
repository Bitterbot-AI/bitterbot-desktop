/**
 * REVIEW (adversarial pass, PLAN-52 Phase 1): data-loss probes for the owned
 * transcript store. Each test states the expected safe behaviour; the ones
 * kept here fail on the current code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { truncateOversizedToolResultsInSession } from "../../embedded-runner/tool-result-truncation.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { TranscriptStore } from "./store.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  timestamp: 2,
  ...extra,
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

describe("REVIEW TranscriptStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-store-review-"));
    file = path.join(dir, "s.jsonl");
  });
  afterEach(() => {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const texts = (store: TranscriptStore) =>
    store
      .buildSessionContext()
      .messages.map((m) => (m.content as Array<{ text: string }>)[0]?.text);

  it("a file whose last line is torn (no trailing newline): the next append must not be glued to it", () => {
    // A crash or ENOSPC in the middle of appendFileSync leaves a partial last
    // line. (The run path repairs the file first; tool-result truncation and
    // an in-process retry after a failed append do not.)
    fs.writeFileSync(
      file,
      `${HEADER}\n${entryLine("u1", null, user("one"))}\n${entryLine("a1", "u1", assistant("two"))}\n{"type":"message","id":"zz","parentId":"a1","mess`,
    );
    const store = TranscriptStore.open(file);
    store.appendMessage(user("three"));
    store.appendMessage(assistant("four"));
    expect(texts(store)).toEqual(["one", "two", "three", "four"]);

    // What the next run sees.
    const reopened = TranscriptStore.open(file);
    expect(texts(reopened)).toEqual(["one", "two", "three", "four"]);
  });

  it("one damaged line in the middle (dropped by session-file-repair) must not hide all history before it", async () => {
    // u1 -> a1 -> [u2: damaged] -> a2 -> u3 -> a3. After the repair drops the
    // damaged line, a2's parent is unknown and the path walk stops there.
    const good = entryLine("u2", "a1", user("three"));
    fs.writeFileSync(
      file,
      [
        HEADER,
        entryLine("u1", null, user("one")),
        entryLine("a1", "u1", assistant("two")),
        good.slice(0, good.length - 20), // torn
        entryLine("a2", "u2", assistant("four")),
        entryLine("u3", "a2", user("five")),
        entryLine("a3", "u3", assistant("six")),
      ].join("\n") + "\n",
    );
    const report = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(report.repaired).toBe(true);
    const store = TranscriptStore.open(file);
    // Losing the damaged message is unavoidable; losing "one" and "two" is not.
    expect(texts(store)).toEqual(["one", "two", "four", "five", "six"]);
  });

  it("one entry that cannot be serialized must not stop every later entry from reaching disk", () => {
    const store = TranscriptStore.open(file);
    store.appendMessage(user("one"));
    store.appendMessage(assistant("two"));
    // A tool result whose details hold a BigInt (viem amounts, sqlite ints).
    expect(() =>
      store.appendMessage({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "wallet",
        content: [{ type: "text", text: "ok" }],
        details: { wei: 10n },
      }),
    ).toThrow();
    // pi (checked with the same steps on SessionManager): only that one append
    // throws and "three" reaches disk. Here every later append throws too and
    // nothing more is written for the life of this instance. The owned
    // session swallows the throw (its event queue catches), so the rest of
    // the run is silently not persisted.
    expect(() => store.appendMessage(assistant("three"))).not.toThrow();
    expect(fs.readFileSync(file, "utf8")).toContain("three");
  });

  it("a line that is valid JSON but not an object (null) must not make the session unopenable", () => {
    fs.writeFileSync(
      file,
      `${HEADER}\n${entryLine("u1", null, user("one"))}\nnull\n${entryLine("a1", "u1", assistant("two"))}\n`,
    );
    expect(() => TranscriptStore.open(file)).not.toThrow();
  });

  it("damaged file + failed rename: what the run then writes must survive the next open", () => {
    if (process.getuid?.() === 0) {
      return; // root ignores directory permissions
    }
    // First parsed line is not a header (e.g. the file was recreated by an
    // append after an archive rename).
    fs.writeFileSync(file, `${entryLine("x1", null, assistant("orphan"))}\n`);
    fs.chmodSync(dir, 0o555); // rename fails, append to the existing file works
    const store = TranscriptStore.open(file);
    store.appendMessage(user("hello"));
    store.appendMessage(assistant("hi there"));
    fs.chmodSync(dir, 0o755);
    expect(fs.readFileSync(file, "utf8")).toContain("hi there");

    const next = TranscriptStore.open(file);
    expect(texts(next)).toEqual(["hello", "hi there"]);
  });

  it("truncateOversizedToolResultsInSession must not drop the kept messages of an earlier compaction", async () => {
    const store = TranscriptStore.open(file);
    store.appendMessage(user("turn 1"));
    store.appendMessage(
      assistant("calling", {
        content: [
          { type: "text", text: "calling" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
        ],
      }),
    );
    store.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "B".repeat(60_000) }],
      timestamp: 3,
    });
    store.appendMessage(assistant("read it"));
    const kept = store.appendMessage(user("turn 2 (first kept)"));
    store.appendMessage(assistant("answer 2"));
    store.appendCompaction("summary of turn 1", kept, 50_000);
    store.appendMessage(user("turn 3"));
    store.appendMessage(assistant("answer 3"));

    const roles = (s: TranscriptStore) =>
      s.buildSessionContext().messages.map((m) => {
        const c = m.content as Array<{ text?: string }> | undefined;
        return m.role === "compactionSummary" ? "SUMMARY" : c?.[0]?.text;
      });
    const before = roles(TranscriptStore.open(file));
    expect(before).toEqual(["SUMMARY", "turn 2 (first kept)", "answer 2", "turn 3", "answer 3"]);

    // A small-window model: the 60k-char result (hidden by the compaction) is
    // "oversized", so the branch is rewritten from it onward with new ids,
    // while the re-appended compaction keeps the OLD firstKeptEntryId.
    const res = await truncateOversizedToolResultsInSession({
      sessionFile: file,
      contextWindowTokens: 16_000,
    });
    // Fixed: a result the compaction already hides is left alone.
    expect(res.truncated).toBe(false);
    expect(roles(TranscriptStore.open(file))).toEqual(before);

    // An oversized result in the kept range is truncated, and the re-appended
    // compaction points at the new id of its first kept entry.
    const again = TranscriptStore.open(file);
    again.appendMessage(user("turn 4"));
    again.appendMessage(
      assistant("calling again", {
        content: [
          { type: "text", text: "calling again" },
          { type: "toolCall", id: "c2", name: "read", arguments: { path: "/y" } },
        ],
      }),
    );
    const bigId = again.appendMessage({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      content: [{ type: "text", text: "C".repeat(60_000) }],
      timestamp: 9,
    });
    const keptLater = again.appendMessage(user("turn 5 (kept by the second compaction)"));
    again.appendMessage(assistant("answer 5"));
    again.appendCompaction("summary of turns 2-4", bigId, 60_000);
    again.appendMessage(user("turn 6"));
    const visible = roles(TranscriptStore.open(file));
    const second = await truncateOversizedToolResultsInSession({
      sessionFile: file,
      contextWindowTokens: 16_000,
    });
    expect(second.truncated).toBe(true);
    const after = TranscriptStore.open(file);
    const afterRoles = roles(after);
    expect(afterRoles).toHaveLength(visible.length);
    expect(afterRoles[0]).toBe("SUMMARY");
    expect(afterRoles.slice(2)).toEqual(visible.slice(2));
    expect(String(afterRoles[1]).length).toBeLessThan(60_000);
    expect(keptLater).toBeTruthy();
  });
});
