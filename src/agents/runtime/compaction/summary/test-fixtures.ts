/**
 * PLAN-52 Phase 3: synthetic transcripts for the summary compaction tests.
 * Test support only; nothing in the runtime imports this file.
 *
 * Entries are built by hand with fixed ids (`e0`, `e1`, ...), a parent chain
 * in append order and fixed timestamps, so results compare exactly between
 * runs and between engines. Text sizes are chosen so that the chars / 4
 * estimate gives round token counts.
 */
import type { TranscriptEntry, TranscriptMessage } from "../../transcript/types.js";

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export type FixtureUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/** A usage record; `totalTokens` defaults to the sum of the components. */
export function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  totalTokens: number = input + output + cacheRead + cacheWrite,
): FixtureUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Text of exactly `tokens * 4` chars, so it is estimated at `tokens`. */
export function textOfTokens(tokens: number, seed = "lorem ipsum "): string {
  return seed.repeat(Math.ceil((tokens * 4) / seed.length)).slice(0, tokens * 4);
}

export function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

export function thinking(value: string): { type: "thinking"; thinking: string } {
  return { type: "thinking", thinking: value };
}

export function image(): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
}

export function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", id, name, arguments: args };
}

type AssistantExtra = {
  usage?: FixtureUsage;
  stopReason?: string;
  errorMessage?: string;
};

type BashExtra = {
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
};

export class TranscriptBuilder {
  readonly entries: TranscriptEntry[] = [];
  private leaf: string | null = null;
  private count = 0;

  private base(): { id: string; parentId: string | null; timestamp: string; ms: number } {
    const index = this.count;
    this.count += 1;
    const ms = BASE_MS + index * 1000;
    const base = {
      id: `e${index}`,
      parentId: this.leaf,
      timestamp: new Date(ms).toISOString(),
      ms,
    };
    this.leaf = base.id;
    return base;
  }

  /** A `message` entry; `build` gets the entry time for `message.timestamp`. */
  message(build: (timestampMs: number) => TranscriptMessage): string {
    const { ms, ...base } = this.base();
    this.entries.push({ type: "message", ...base, message: build(ms) });
    return base.id;
  }

  user(content: string | unknown[]): string {
    return this.message((timestamp) => ({ role: "user", content, timestamp }));
  }

  assistant(content: unknown[], extra: AssistantExtra = {}): string {
    return this.message((timestamp) => {
      const message: TranscriptMessage = {
        role: "assistant",
        content,
        api: "fixture-api",
        provider: "fixture",
        model: "fixture-model",
        usage: extra.usage ?? usage(0, 0),
        stopReason: extra.stopReason ?? "stop",
        timestamp,
      };
      if (extra.errorMessage !== undefined) {
        message.errorMessage = extra.errorMessage;
      }
      return message;
    });
  }

  toolResult(
    toolCallId: string,
    toolName: string,
    content: string | unknown[],
    isError = false,
  ): string {
    return this.message((timestamp) => ({
      role: "toolResult",
      toolCallId,
      toolName,
      content: typeof content === "string" ? [text(content)] : content,
      isError,
      timestamp,
    }));
  }

  bash(command: string, output: string, extra: BashExtra = {}): string {
    return this.message((timestamp) => {
      const message: TranscriptMessage = {
        role: "bashExecution",
        command,
        output,
        exitCode: extra.exitCode,
        cancelled: extra.cancelled ?? false,
        truncated: extra.truncated ?? false,
        timestamp,
      };
      if (extra.fullOutputPath !== undefined) {
        message.fullOutputPath = extra.fullOutputPath;
      }
      if (extra.excludeFromContext !== undefined) {
        message.excludeFromContext = extra.excludeFromContext;
      }
      return message;
    });
  }

  customMessage(customType: string, content: unknown, display = true, details?: unknown): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "custom_message", customType, content, display, details, ...base });
    return base.id;
  }

  branchSummary(summary: string, fromId = "root"): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "branch_summary", ...base, fromId, summary });
    return base.id;
  }

  compaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({
      type: "compaction",
      ...base,
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    });
    return base.id;
  }

  modelChange(provider: string, modelId: string): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "model_change", ...base, provider, modelId });
    return base.id;
  }

  thinkingLevelChange(thinkingLevel: string): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "thinking_level_change", ...base, thinkingLevel });
    return base.id;
  }

  label(targetId: string, label: string): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "label", ...base, targetId, label });
    return base.id;
  }

  custom(customType: string, data?: unknown): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "custom", customType, data, ...base });
    return base.id;
  }

  sessionInfo(name: string): string {
    const { ms: _ms, ...base } = this.base();
    this.entries.push({ type: "session_info", ...base, name });
    return base.id;
  }
}

/** Four short text turns, no compaction yet. Each message is 25 tokens. */
function plain(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  for (let turn = 1; turn <= 4; turn++) {
    b.user(textOfTokens(25, `question ${turn} `));
    b.assistant([text(textOfTokens(25, `answer ${turn} `))], { usage: usage(100 * turn, 25) });
  }
  return b.entries;
}

/** Tool calls with read / write / edit arguments, thinking, a long tool result. */
function toolsAndFiles(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user("Please refactor the parser.");
  b.assistant(
    [
      thinking("I should read the parser first."),
      text("Reading the parser."),
      toolCall("c1", "read", { path: "src/parser.ts" }),
    ],
    { usage: usage(200, 20), stopReason: "toolUse" },
  );
  b.toolResult("c1", "read", textOfTokens(750, "export function parse() {}\n"));
  b.assistant(
    [
      toolCall("c2", "edit", { path: "src/parser.ts", oldText: "a", newText: "b" }),
      toolCall("c3", "write", { path: "src/new-file.ts", content: "export {};\n" }),
      toolCall("c4", "read", { path: "src/lexer.ts", offset: 10, limit: 20 }),
      toolCall("c5", "bash", { command: "pnpm test", timeout: 60 }),
    ],
    { usage: usage(1200, 60), stopReason: "toolUse" },
  );
  b.toolResult("c2", "edit", "Edited src/parser.ts");
  b.toolResult("c3", "write", "Wrote src/new-file.ts");
  b.toolResult("c4", "read", "token stream");
  b.toolResult("c5", "bash", "1 failed", true);
  b.assistant([text("One test fails."), thinking("Why?"), text("Looking into it.")], {
    usage: usage(1500, 30),
  });
  b.user("Check the config too.");
  b.assistant(
    [
      // Not counted as file operations: a non-string path, another key, another tool name.
      toolCall("c6", "read", { path: 42 }),
      toolCall("c7", "read", { file_path: "src/ignored.ts" }),
      toolCall("c8", "Read", { path: "src/wrong-case.ts" }),
      toolCall("c9", "read", { path: "config/app.json" }),
    ],
    { usage: usage(1700, 40), stopReason: "toolUse" },
  );
  b.toolResult("c6", "read", [image(), text("a picture and "), text("some text")]);
  b.toolResult("c7", "read", [image()]);
  b.toolResult("c8", "Read", "");
  b.toolResult("c9", "read", '{"a":1}');
  b.assistant([text("Config looks fine.")], { usage: usage(3000, 10) });
  return b.entries;
}

/** A short first turn, then one long turn; a small budget cuts inside the long turn. */
function splitTurn(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user("First, say hello.");
  b.assistant([text("Hello.")], { usage: usage(50, 5) });
  b.user("Now migrate the database layer to the new driver.");
  b.assistant([text("Starting."), toolCall("s1", "read", { path: "db/driver.ts" })], {
    usage: usage(120, 20),
    stopReason: "toolUse",
  });
  b.toolResult("s1", "read", textOfTokens(100, "driver code "));
  b.assistant([toolCall("s2", "edit", { path: "db/driver.ts", oldText: "x", newText: "y" })], {
    usage: usage(300, 20),
    stopReason: "toolUse",
  });
  b.toolResult("s2", "edit", "ok");
  b.assistant([toolCall("s3", "write", { path: "db/migrate.sql", content: "select 1;" })], {
    usage: usage(350, 20),
    stopReason: "toolUse",
  });
  b.toolResult("s3", "write", "ok");
  b.assistant([text(textOfTokens(40, "migration done "))], { usage: usage(400, 40) });
  return b.entries;
}

/** One long turn only: a cut inside it has no earlier history. */
function splitTurnNoHistory(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user("Build the report.");
  b.assistant([toolCall("n1", "read", { path: "data/input.csv" })], {
    usage: usage(40, 10),
    stopReason: "toolUse",
  });
  b.toolResult("n1", "read", textOfTokens(60, "1,2,3\n"));
  b.assistant([toolCall("n2", "write", { path: "out/report.md", content: "# Report" })], {
    usage: usage(120, 10),
    stopReason: "toolUse",
  });
  b.toolResult("n2", "write", "ok");
  b.assistant([text(textOfTokens(30, "report written "))], { usage: usage(150, 30) });
  return b.entries;
}

/** The budget is reached on a trailing tool result with no cut point after it. */
function onlyToolResultAfter(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user("Dump the log.");
  b.assistant([toolCall("o1", "bash", { command: "cat big.log" })], {
    usage: usage(30, 10),
    stopReason: "toolUse",
  });
  b.toolResult("o1", "bash", textOfTokens(900, "log line\n"));
  return b.entries;
}

/** A tool result reaches the budget; the cut moves to the next assistant message. */
function cutOnToolResult(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user("Earlier question.");
  b.assistant([text("Earlier answer.")], { usage: usage(20, 5) });
  b.user("Search the tree.");
  b.assistant([toolCall("t1", "grep", { pattern: "TODO", path: "src" })], {
    usage: usage(40, 10),
    stopReason: "toolUse",
  });
  b.toolResult("t1", "grep", textOfTokens(200, "src/a.ts: TODO\n"));
  b.toolResult("t1b", "grep", textOfTokens(10, "more\n"));
  b.assistant([text(textOfTokens(10, "found some "))], { usage: usage(300, 10) });
  b.user(textOfTokens(10, "thanks "));
  b.assistant([text(textOfTokens(10, "welcome "))], { usage: usage(330, 10) });
  return b.entries;
}

function previousCompaction(
  options: { fromHook?: boolean; firstKept?: string; details?: unknown } = {},
): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user(textOfTokens(20, "old question one "));
  b.assistant([text(textOfTokens(20, "old answer one "))], { usage: usage(40, 20) });
  const kept = b.user(textOfTokens(20, "old question two "));
  b.assistant([text("old answer two"), toolCall("p0", "read", { path: "src/kept-read.ts" })], {
    usage: usage(90, 20),
    stopReason: "toolUse",
  });
  b.toolResult("p0", "read", "kept file body");
  b.compaction(
    "## Goal\nEarlier work.\n\n## Progress\n### Done\n- [x] Question one",
    options.firstKept ?? kept,
    110,
    "details" in options
      ? options.details
      : { readFiles: ["old/read.ts", "old/both.ts"], modifiedFiles: ["old/mod.ts"] },
    options.fromHook,
  );
  b.user(textOfTokens(20, "new question three "));
  b.assistant([toolCall("p1", "edit", { path: "old/both.ts", oldText: "a", newText: "b" })], {
    usage: usage(160, 20),
    stopReason: "toolUse",
  });
  b.toolResult("p1", "edit", "ok");
  b.assistant([text(textOfTokens(20, "new answer three "))], { usage: usage(200, 20) });
  b.user(textOfTokens(20, "new question four "));
  b.assistant([text(textOfTokens(20, "new answer four "))], { usage: usage(240, 20) });
  return b.entries;
}

/** The last entry is a compaction: nothing to compact. */
function endsWithCompaction(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  const first = b.user("A question.");
  b.assistant([text("An answer.")], { usage: usage(10, 5) });
  b.compaction("Summary so far.", first, 15);
  return b.entries;
}

/** `custom_message`, `branch_summary` and non-context entries between turns. */
function customAndBranch(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.branchSummary("An abandoned attempt at the cache layer.");
  b.user(textOfTokens(15, "question a "));
  b.assistant([text(textOfTokens(15, "answer a "))], { usage: usage(60, 15) });
  b.customMessage("memory-recall", "Recalled: the user prefers tabs.", true, { score: 0.9 });
  b.assistant([text(textOfTokens(15, "answer b "))], { usage: usage(90, 15) });
  b.custom("bookkeeping", { n: 1 });
  b.label("e1", "checkpoint");
  b.customMessage("screenshot", [text("See the attached image."), image()], false);
  b.assistant([text(textOfTokens(15, "answer c "))], { usage: usage(1400, 15) });
  b.sessionInfo("fixture session");
  b.branchSummary("A side quest about logging.", "e4");
  b.assistant([text(textOfTokens(15, "answer d "))], { usage: usage(1450, 15) });
  b.user(textOfTokens(15, "question e "));
  b.assistant([text(textOfTokens(15, "answer e "))], { usage: usage(1500, 15) });
  return b.entries;
}

/** Bash executions in every shape, as turn starts and inside turns. */
function bash(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user(textOfTokens(10, "run things "));
  b.assistant([text(textOfTokens(10, "sure "))], { usage: usage(30, 10) });
  b.bash("ls -la", "total 0\nfile.txt", { exitCode: 0 });
  b.bash("cat secrets.env", "TOKEN=abc", { exitCode: 0, excludeFromContext: true });
  b.bash("sleep 100", "", { cancelled: true });
  b.bash("make build", textOfTokens(30, "error: "), {
    exitCode: 2,
    truncated: true,
    fullOutputPath: "/tmp/pi-bash-1.log",
  });
  b.bash("true", "");
  b.assistant([text(textOfTokens(10, "seen "))], { usage: usage(120, 10) });
  b.user(textOfTokens(10, "and now "));
  b.assistant([text(textOfTokens(10, "done "))], { usage: usage(150, 10) });
  return b.entries;
}

/** Images in user content and tool results. */
function images(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user([text("What is in this picture?"), image()]);
  b.assistant([text("A cat."), toolCall("i1", "screenshot", {})], {
    usage: usage(1300, 5),
    stopReason: "toolUse",
  });
  b.toolResult("i1", "screenshot", [image(), image()]);
  b.assistant([text("And now a dog.")], { usage: usage(3800, 5) });
  b.user([image()]);
  b.assistant([text("A bird.")], { usage: usage(5100, 5) });
  return b.entries;
}

/** The last assistant messages failed; their usage must be ignored. */
function erroredLastAssistant(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user(textOfTokens(20, "first "));
  b.assistant([text(textOfTokens(20, "ok "))], { usage: usage(5000, 20, 100, 50) });
  b.user(textOfTokens(20, "second "));
  b.assistant([text("partial")], { usage: usage(9999, 1), stopReason: "aborted" });
  b.user(textOfTokens(20, "third "));
  b.assistant([], {
    usage: usage(0, 0),
    stopReason: "error",
    errorMessage: "529 overloaded",
  });
  return b.entries;
}

/** Settings entries right before a user message: pi reports the cut as a split turn. */
function settingsBeforeUser(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.user(textOfTokens(20, "first question "));
  b.assistant([text(textOfTokens(20, "first answer "))], { usage: usage(40, 20) });
  b.modelChange("fixture", "other-model");
  b.thinkingLevelChange("high");
  b.user(textOfTokens(20, "second question "));
  b.assistant([text(textOfTokens(20, "second answer "))], { usage: usage(80, 20) });
  return b.entries;
}

/** `message` entries that carry custom roles, an unknown role, and odd usage. */
function messageEntriesWithCustomRoles(): TranscriptEntry[] {
  const b = new TranscriptBuilder();
  b.message((timestamp) => ({
    role: "compactionSummary",
    summary: textOfTokens(12, "inline summary "),
    tokensBefore: 77,
    timestamp,
  }));
  b.user(textOfTokens(12, "question "));
  // No totalTokens: the context size falls back to the component sum.
  b.assistant([text(textOfTokens(12, "answer "))], { usage: usage(70, 12, 30, 8, 0) });
  b.message((timestamp) => ({
    role: "custom",
    customType: "note",
    content: textOfTokens(12, "inline custom "),
    display: true,
    timestamp,
  }));
  b.message((timestamp) => ({
    role: "branchSummary",
    summary: textOfTokens(12, "inline branch "),
    fromId: "e0",
    timestamp,
  }));
  b.message((timestamp) => ({ role: "mystery", content: "not a known role", timestamp }));
  b.user(textOfTokens(12, "question two "));
  b.message((timestamp) => ({ role: "user", content: [], timestamp }));
  return b.entries;
}

/** Every synthetic transcript, by name. Each call builds fresh entries. */
export const SCENARIOS: Record<string, () => TranscriptEntry[]> = {
  empty: () => [],
  plain,
  toolsAndFiles,
  splitTurn,
  splitTurnNoHistory,
  onlyToolResultAfter,
  cutOnToolResult,
  previousCompaction: () => previousCompaction(),
  previousCompactionFromHook: () => previousCompaction({ fromHook: true }),
  previousCompactionMissingFirstKept: () => previousCompaction({ firstKept: "not-on-path" }),
  previousCompactionOddDetails: () => previousCompaction({ details: "not an object" }),
  endsWithCompaction,
  customAndBranch,
  bash,
  images,
  erroredLastAssistant,
  settingsBeforeUser,
  messageEntriesWithCustomRoles,
};
