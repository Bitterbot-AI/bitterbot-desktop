/**
 * PLAN-52 Phase 5: differential tests, our read / write / edit tools vs
 * pi-coding-agent 0.73.1.
 *
 * Each case runs pi's tool and ours on the same fixture in the same cwd (the
 * directory is wiped and rebuilt between the two runs) and the outcomes must
 * be strictly equal: the result (`content` and `details`) or the error, plus
 * every file under the temp root afterwards.
 *
 * The tool definitions are compared as serialized bytes, because name,
 * description and parameter schema are sent to the model and decide the prompt
 * cache prefix.
 *
 * Known, accepted difference (see `image-resize.ts`): a resized image is
 * encoded by sharp here and by Photon in pi, so its bytes differ. Those cases
 * compare the note text, the MIME type and the decoded dimensions.
 *
 * `edit-diff.js` is not exported from pi's package index, so it is imported
 * from the dist file by relative path. jsdiff is resolved from pi's own
 * dependencies.
 *
 * This file is deleted when the pi-coding-agent dependency goes (PLAN-52
 * Phase 5); `coding-tools.test.ts` holds the tests that stay.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@mariozechner/pi-ai";
import {
  createCodingTools as piCreateCodingTools,
  createEditTool as piCreateEditTool,
  createReadTool as piCreateReadTool,
  createWriteTool as piCreateWriteTool,
  DEFAULT_MAX_BYTES as PI_DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES as PI_DEFAULT_MAX_LINES,
  formatSize as piFormatSize,
  truncateHead as piTruncateHead,
  withFileMutationQueue as piWithFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEditsToNormalizedContent as piApplyEditsToNormalizedContent,
  generateDiffString as piGenerateDiffString,
} from "../../../../../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import {
  expandPath as piExpandPath,
  resolveReadPath as piResolveReadPath,
  resolveToCwd as piResolveToCwd,
} from "../../../../../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import {
  CLAUDE_PARAM_GROUPS,
  createBitterbotReadTool,
  wrapToolParamNormalization,
} from "../../../agent-tools.read.js";
import type { AnyAgentTool } from "../../../agent-tools.types.js";
import { toPlainJsonSchema } from "../../../schema/plain-json-schema.js";
import { applyEditsToNormalizedContent, generateDiffString } from "./edit-diff.js";
import {
  CODING_FILE_TOOL_NAMES,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type EditOperations,
  formatSize,
  type ReadOperations,
  type ReadToolOptions,
  truncateHead,
  withFileMutationQueue,
  type WriteOperations,
} from "./index.js";
import { diffLines, type LineChange } from "./line-diff.js";
import { expandPath, resolveReadPath, resolveToCwd } from "./path-utils.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Side = "pi" | "ours";

interface Factories {
  read: (options?: ReadToolOptions) => AnyAgentTool;
  write: (options?: { operations?: WriteOperations }) => AnyAgentTool;
  edit: (options?: { operations?: EditOperations }) => AnyAgentTool;
}

function factories(side: Side, cwd: string): Factories {
  if (side === "pi") {
    return {
      read: (options) => piCreateReadTool(cwd, options) as unknown as AnyAgentTool,
      write: (options) => piCreateWriteTool(cwd, options) as unknown as AnyAgentTool,
      edit: (options) => piCreateEditTool(cwd, options) as unknown as AnyAgentTool,
    };
  }
  return {
    read: (options) => createReadTool(cwd, options),
    write: (options) => createWriteTool(cwd, options),
    edit: (options) => createEditTool(cwd, options),
  };
}

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; sync: boolean; name: string; message: string; code: unknown };

function describeError(error: unknown, sync: boolean): Outcome {
  if (error instanceof Error) {
    return {
      ok: false,
      sync,
      name: error.name,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
    };
  }
  return { ok: false, sync, name: "non-error", message: String(error), code: undefined };
}

/** Run `fn`, telling a synchronous throw from a rejected promise. */
async function settle(fn: () => unknown): Promise<Outcome> {
  let pending: unknown;
  try {
    pending = fn();
  } catch (error) {
    return describeError(error, true);
  }
  try {
    return { ok: true, value: await pending };
  } catch (error) {
    return describeError(error, false);
  }
}

/** Every file, directory and symlink under `dir`, with file bytes as base64. */
function snapshotTree(dir: string, prefix = ""): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      tree[rel] = `link:${fs.readlinkSync(full)}`;
    } else if (entry.isDirectory()) {
      tree[`${rel}/`] = "dir";
      Object.assign(tree, snapshotTree(full, rel));
    } else {
      tree[rel] = `file:${fs.readFileSync(full).toString("base64")}`;
    }
  }
  return tree;
}

let root = "";
let cwd = "";
let home = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-coding-tools-diff-"));
  cwd = path.join(root, "ws");
  home = path.join(root, "home");
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function resetDirs(): void {
  for (const dir of [cwd, home]) {
    if (fs.existsSync(dir)) {
      // A test may have made something read-only.
      fs.chmodSync(dir, 0o755);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
}

interface SideResult {
  outcome: Outcome;
  tree: Record<string, string>;
  extra: unknown;
}

/**
 * Run the same scenario against pi's tools and ours, each on a freshly built
 * fixture in the same cwd, and require strictly equal outcomes and file trees.
 * `run` may return extra data (for example a call log) through `extra`.
 */
async function both(
  setup: (() => void | Promise<void>) | undefined,
  run: (tools: Factories, extra: unknown[]) => unknown,
): Promise<SideResult> {
  const results = {} as Record<Side, SideResult>;
  for (const side of ["pi", "ours"] as const) {
    resetDirs();
    await setup?.();
    const extra: unknown[] = [];
    const outcome = await settle(() => run(factories(side, cwd), extra));
    results[side] = { outcome, tree: snapshotTree(root), extra };
  }
  expect(results.ours).toStrictEqual(results.pi);
  return results.ours;
}

function file(rel: string, content: string | Buffer): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function expectOk(result: SideResult): { content: unknown[]; details: unknown } {
  expect(result.outcome.ok, JSON.stringify(result.outcome)).toBe(true);
  return (result.outcome as { ok: true; value: { content: unknown[]; details: unknown } }).value;
}

function expectError(result: SideResult, pattern: RegExp | string): void {
  expect(result.outcome.ok).toBe(false);
  const failure = result.outcome as { ok: false; sync: boolean; message: string };
  // Both tools are async: a failure is always a rejection.
  expect(failure.sync).toBe(false);
  if (typeof pattern === "string") {
    expect(failure.message).toBe(pattern);
  } else {
    expect(failure.message).toMatch(pattern);
  }
}

function firstText(result: SideResult): string {
  const block = expectOk(result).content[0] as { type: string; text: string };
  expect(block.type).toBe("text");
  return block.text;
}

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lines(count: number, make: (i: number) => string = (i) => `line ${i}`): string {
  return Array.from({ length: count }, (_, i) => make(i + 1)).join("\n");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe("tool definitions vs pi", () => {
  const pairs = () => {
    const pi = factories("pi", "/tmp/definitions");
    const ours = factories("ours", "/tmp/definitions");
    return [
      { name: "read", pi: pi.read(), ours: ours.read() },
      { name: "write", pi: pi.write(), ours: ours.write() },
      { name: "edit", pi: pi.edit(), ours: ours.edit() },
    ];
  };

  it("has the same keys, name, label and description, byte for byte", () => {
    for (const pair of pairs()) {
      expect(Object.keys(pair.ours)).toStrictEqual(Object.keys(pair.pi));
      expect(pair.ours.name).toBe(pair.name);
      expect(pair.ours.name).toBe(pair.pi.name);
      expect(pair.ours.label).toBe(pair.pi.label);
      expect(pair.ours.description).toBe(pair.pi.description);
      expect(pair.ours.executionMode).toBe(pair.pi.executionMode);
      expect(typeof pair.ours.prepareArguments).toBe(typeof pair.pi.prepareArguments);
      expect(typeof pair.ours.execute).toBe("function");
    }
  });

  it("serializes the parameter schema to the same bytes, key order included", () => {
    for (const pair of pairs()) {
      expect(JSON.stringify(pair.ours.parameters)).toBe(JSON.stringify(pair.pi.parameters));
      // What the pi engine adapter hands to the provider (toToolDefinitions).
      expect(JSON.stringify(toPlainJsonSchema(pair.ours.parameters))).toBe(
        JSON.stringify(toPlainJsonSchema(pair.pi.parameters)),
      );
      // No typebox symbols on either side: pi-ai skips its JSON coercion when it sees one.
      expect(Object.getOwnPropertySymbols(pair.ours.parameters as object)).toStrictEqual([]);
      expect(Object.getOwnPropertySymbols(pair.pi.parameters as object)).toStrictEqual([]);
    }
  });

  it("gives the same wire schema after the gateway's Claude-compat wrappers", () => {
    const wrap = (tool: AnyAgentTool) =>
      tool.name === "read"
        ? createBitterbotReadTool(tool)
        : wrapToolParamNormalization(
            tool,
            tool.name === "write" ? CLAUDE_PARAM_GROUPS.write : CLAUDE_PARAM_GROUPS.edit,
          );
    for (const pair of pairs()) {
      const ours = wrap(pair.ours);
      const pi = wrap(pair.pi);
      expect(
        JSON.stringify({
          name: ours.name,
          description: ours.description,
          parameters: toPlainJsonSchema(ours.parameters),
        }),
      ).toBe(
        JSON.stringify({
          name: pi.name,
          description: pi.description,
          parameters: toPlainJsonSchema(pi.parameters),
        }),
      );
    }
  });

  it("returns one shared schema object per tool, as pi does", () => {
    expect(createReadTool("/a").parameters).toBe(createReadTool("/b").parameters);
    expect(piCreateReadTool("/a").parameters).toBe(piCreateReadTool("/b").parameters);
    expect(createWriteTool("/a").parameters).toBe(createWriteTool("/b").parameters);
    expect(createEditTool("/a").parameters).toBe(createEditTool("/b").parameters);
  });

  it("keeps the order of pi's createCodingTools without bash", () => {
    const piNames = piCreateCodingTools("/tmp/definitions").map((tool) => tool.name);
    expect(piNames).toStrictEqual(["read", "bash", "edit", "write"]);
    expect([...CODING_FILE_TOOL_NAMES]).toStrictEqual(piNames.filter((name) => name !== "bash"));
  });

  it("validates and coerces arguments like pi's schemas (pi-ai validateToolArguments)", () => {
    const argumentSets: Record<string, unknown[]> = {
      read: [
        { path: "a.txt" },
        { path: "a.txt", offset: 3, limit: 5 },
        { path: "a.txt", offset: "3", limit: "5" },
        { path: "a.txt", offset: "x" },
        { path: "a.txt", offset: null },
        { path: "a.txt", limit: true },
        { path: "a.txt", extra: 1 },
        { path: 5 },
        { path: null },
        { file_path: "a.txt" },
        {},
        { path: "a.txt", offset: 1.5 },
      ],
      write: [
        { path: "a.txt", content: "x" },
        { path: "a.txt", content: 5 },
        { path: "a.txt", content: null },
        { path: "a.txt" },
        { content: "x" },
        { path: "a.txt", content: "x", extra: true },
        { path: ["a"], content: "x" },
        {},
      ],
      edit: [
        { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
        { path: "a.txt", edits: [] },
        { path: "a.txt", edits: [{ oldText: "a" }] },
        { path: "a.txt", edits: [{ oldText: "a", newText: "b", replace_all: false }] },
        { path: "a.txt", edits: [{ oldText: 1, newText: 2 }] },
        { path: "a.txt", edits: "nope" },
        { path: "a.txt", edits: [{ oldText: "a", newText: "b" }], extra: 1 },
        { path: "a.txt", oldText: "a", newText: "b" },
        { path: "a.txt" },
        { edits: [{ oldText: "a", newText: "b" }] },
        { path: "a.txt", edits: [null] },
        {},
      ],
    };
    const validate = (tool: AnyAgentTool, parameters: unknown, args: unknown) => {
      try {
        return {
          ok: true,
          value: validateToolArguments(
            { name: tool.name, description: tool.description, parameters: parameters as never },
            { type: "toolCall", id: "call_1", name: tool.name, arguments: args as never },
          ) as unknown,
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    };
    let accepted = 0;
    let rejected = 0;
    const rawPiDiffers: string[] = [];
    for (const pair of pairs()) {
      for (const args of argumentSets[pair.name]) {
        const label = `${pair.name} ${JSON.stringify(args)}`;
        // Every validation path in the gateway (both engines and the tool
        // dispatcher) validates against the symbol-free JSON copy of the
        // schema, so that is the reference.
        const reference = validate(
          pair.pi,
          toPlainJsonSchema(pair.pi.parameters),
          structuredClone(args),
        );
        expect(
          validate(pair.ours, pair.ours.parameters, structuredClone(args)),
          label,
        ).toStrictEqual(reference);
        expect(
          validate(pair.ours, toPlainJsonSchema(pair.ours.parameters), structuredClone(args)),
          label,
        ).toStrictEqual(reference);
        // The same after the gateway's Claude-compat wrapper rebuilt the root
        // object of pi's schema (nested typebox 1.x markers survive there).
        const piRoot = pair.pi.parameters as { properties: Record<string, unknown> };
        expect(
          validate(
            pair.pi,
            { ...piRoot, properties: { ...piRoot.properties } },
            structuredClone(args),
          ),
          label,
        ).toStrictEqual(reference);
        const rawPi = validate(pair.pi, pair.pi.parameters, structuredClone(args));
        if (JSON.stringify(rawPi) !== JSON.stringify(reference)) {
          rawPiDiffers.push(label);
        }
        if (reference.ok) {
          accepted += 1;
        } else {
          rejected += 1;
        }
      }
    }
    // Known difference, outside every gateway path: pi's untouched schema
    // object carries a typebox 1.x `~kind` marker at its root, which makes
    // typebox convert values itself (null becomes "null", a string becomes a
    // one-element array) before pi-ai's JSON coercion (null becomes "") runs.
    // Our schema is plain JSON, so it always behaves like the copy the gateway
    // validated against.
    expect(rawPiDiffers).toStrictEqual([
      'read {"path":null}',
      'write {"path":"a.txt","content":null}',
      'edit {"path":"a.txt","edits":"nope"}',
    ]);
    // Guard against a vacuous comparison: both branches were exercised.
    expect(accepted).toBeGreaterThan(5);
    expect(rejected).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// prepareArguments
// ---------------------------------------------------------------------------

describe("prepareArguments vs pi", () => {
  it("read and write have no argument shim on either side", () => {
    for (const side of ["pi", "ours"] as const) {
      const tools = factories(side, "/tmp/prepare");
      expect(tools.read().prepareArguments).toBeUndefined();
      expect(tools.write().prepareArguments).toBeUndefined();
    }
  });

  it("edit folds legacy shapes the same way, including key order and input mutation", () => {
    const inputs: unknown[] = [
      { path: "a.txt", oldText: "a", newText: "b" },
      { oldText: "a", newText: "b", path: "a.txt" },
      { path: "a.txt", edits: [{ oldText: "x", newText: "y" }], oldText: "a", newText: "b" },
      { oldText: "a", edits: [{ oldText: "x", newText: "y" }], newText: "b", path: "a.txt" },
      { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] },
      { path: "a.txt", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) },
      {
        path: "a.txt",
        edits: JSON.stringify([{ oldText: "x", newText: "y" }]),
        oldText: "a",
        newText: "b",
      },
      { path: "a.txt", edits: "not json" },
      { path: "a.txt", edits: '{"oldText":"x","newText":"y"}' },
      { path: "a.txt", edits: "not json", oldText: "a", newText: "b" },
      { path: "a.txt", oldText: "a" },
      { path: "a.txt", newText: "b" },
      { path: "a.txt", oldText: 1, newText: "b" },
      { path: "a.txt", oldText: "a", newText: null },
      { path: "a.txt", oldText: "", newText: "" },
      { path: "a.txt", oldText: "a", newText: "b", replace_all: true, extra: { nested: 1 } },
      { file_path: "a.txt", old_string: "a", new_string: "b" },
      { path: "a.txt", edits: null, oldText: "a", newText: "b" },
      { path: "a.txt", edits: {}, oldText: "a", newText: "b" },
      {},
      [],
      [{ oldText: "a", newText: "b" }],
      null,
      undefined,
      "a string",
      42,
      true,
    ];
    const prepareWith = (tool: AnyAgentTool, input: unknown) => {
      const copy = input === undefined ? undefined : (structuredClone(input) as unknown);
      const output = tool.prepareArguments?.(copy) as unknown;
      return {
        output: JSON.stringify(output),
        outputType: typeof output,
        inputAfter: JSON.stringify(copy),
        sameObject: output === copy,
      };
    };
    const pi = factories("pi", "/tmp/prepare").edit();
    const ours = factories("ours", "/tmp/prepare").edit();
    for (const input of inputs) {
      expect(prepareWith(ours, input), JSON.stringify(input)).toStrictEqual(prepareWith(pi, input));
    }
    // Absolute check on the main legacy shape.
    expect(ours.prepareArguments?.({ path: "a.txt", oldText: "a", newText: "b" })).toStrictEqual({
      path: "a.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
  });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("read vs pi", () => {
  it("reads small text files", async () => {
    for (const content of [
      "hello\nworld\n",
      "no trailing newline",
      "",
      "\n",
      "\n\n\n",
      "a\r\nb\r\n",
    ]) {
      const result = await both(
        () => file("note.txt", content),
        (tools) => tools.read().execute("call_1", { path: "note.txt" }),
      );
      expect(firstText(result)).toBe(content);
      expect(expectOk(result).details).toBeUndefined();
    }
  });

  it("truncates at the line limit with a continuation hint", async () => {
    const result = await both(
      () => file("big.txt", lines(2500)),
      (tools) => tools.read().execute("call_1", { path: "big.txt" }),
    );
    expect(firstText(result)).toMatch(
      /line 2000\n\n\[Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\]$/,
    );
    expect(expectOk(result).details).toMatchObject({
      truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 2500 },
    });
  });

  it("does not truncate at exactly the line limit, and does one line over", async () => {
    const exact = await both(
      () => file("exact.txt", lines(2000)),
      (tools) => tools.read().execute("call_1", { path: "exact.txt" }),
    );
    expect(expectOk(exact).details).toBeUndefined();
    const over = await both(
      () => file("over.txt", lines(2001)),
      (tools) => tools.read().execute("call_1", { path: "over.txt" }),
    );
    expect(firstText(over)).toMatch(
      /\[Showing lines 1-2000 of 2001\. Use offset=2001 to continue\.\]$/,
    );
  });

  it("truncates at the byte limit with a continuation hint", async () => {
    const result = await both(
      () =>
        file(
          "wide.txt",
          lines(1000, (i) => `${i}:${"x".repeat(200)}`),
        ),
      (tools) => tools.read().execute("call_1", { path: "wide.txt" }),
    );
    expect(firstText(result)).toMatch(
      /\[Showing lines 1-\d+ of 1000 \(50\.0KB limit\)\. Use offset=\d+ to continue\.\]$/,
    );
    expect(expectOk(result).details).toMatchObject({ truncation: { truncatedBy: "bytes" } });
  });

  it("handles multi-byte text at the byte limit", async () => {
    const result = await both(
      () =>
        file(
          "utf8.txt",
          lines(900, (i) => `${i} ${"é漢🙂".repeat(20)}`),
        ),
      (tools) => tools.read().execute("call_1", { path: "utf8.txt" }),
    );
    expect(expectOk(result).details).toMatchObject({ truncation: { truncatedBy: "bytes" } });
  });

  it("reports a first line that exceeds the byte limit", async () => {
    const result = await both(
      () => file("oneline.txt", `${"y".repeat(60 * 1024)}\nsecond\n`),
      (tools) => tools.read().execute("call_1", { path: "oneline.txt" }),
    );
    expect(firstText(result)).toBe(
      "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' oneline.txt | head -c 51200]",
    );
    const later = await both(
      () => file("oneline.txt", `first\n${"y".repeat(60 * 1024)}\nthird\n`),
      (tools) => tools.read().execute("call_1", { path: "oneline.txt", offset: 2 }),
    );
    expect(firstText(later)).toMatch(/^\[Line 2 is 60\.0KB/);
  });

  it("applies offset and limit the same way", async () => {
    const cases: Array<Record<string, unknown>> = [
      { offset: 1 },
      { offset: 5 },
      { offset: 10 },
      { offset: 0 },
      { offset: -3 },
      { limit: 3 },
      { limit: 10 },
      { limit: 11 },
      { limit: 0 },
      { limit: 100 },
      { offset: 4, limit: 2 },
      { offset: 9, limit: 2 },
      { offset: 9, limit: 1 },
      { offset: 10, limit: 5 },
      { offset: 2.5, limit: 1.5 },
      { offset: 4, limit: -1 },
    ];
    for (const args of cases) {
      const result = await both(
        () => file("ten.txt", lines(10)),
        (tools) => tools.read().execute("call_1", { path: "ten.txt", ...args }),
      );
      expect(result.outcome.ok, JSON.stringify(args)).toBe(true);
    }
    const partial = await both(
      () => file("ten.txt", lines(10)),
      (tools) => tools.read().execute("call_1", { path: "ten.txt", offset: 4, limit: 2 }),
    );
    expect(firstText(partial)).toBe(
      "line 4\nline 5\n\n[5 more lines in file. Use offset=6 to continue.]",
    );
  });

  it("combines offset with truncation on a large file", async () => {
    const result = await both(
      () => file("big.txt", lines(5000)),
      (tools) => tools.read().execute("call_1", { path: "big.txt", offset: 1500 }),
    );
    expect(firstText(result)).toMatch(
      /\[Showing lines 1500-3499 of 5000\. Use offset=3500 to continue\.\]$/,
    );
    const limited = await both(
      () => file("big.txt", lines(5000)),
      (tools) => tools.read().execute("call_1", { path: "big.txt", offset: 100, limit: 3000 }),
    );
    expect(firstText(limited)).toMatch(
      /\[Showing lines 100-2099 of 5000\. Use offset=2100 to continue\.\]$/,
    );
  });

  it("rejects an offset beyond the end of the file", async () => {
    const result = await both(
      () => file("ten.txt", lines(10)),
      (tools) => tools.read().execute("call_1", { path: "ten.txt", offset: 11 }),
    );
    expectError(result, "Offset 11 is beyond end of file (10 lines total)");
  });

  it("fails the same way on a missing file, a directory and missing arguments", async () => {
    expectError(
      await both(undefined, (tools) => tools.read().execute("call_1", { path: "missing.txt" })),
      /ENOENT/,
    );
    expectError(
      await both(
        () => fs.mkdirSync(path.join(cwd, "folder")),
        (tools) => tools.read().execute("call_1", { path: "folder" }),
      ),
      /EISDIR/,
    );
    for (const args of [{}, undefined, null, { path: 5 }, { path: "" }]) {
      const result = await both(undefined, (tools) => tools.read().execute("call_1", args));
      expect(result.outcome.ok, JSON.stringify(args)).toBe(false);
      expect((result.outcome as { sync: boolean }).sync).toBe(false);
    }
  });

  it("reads binary data that is not an image as text", async () => {
    const random = prng(7);
    const bytes = Buffer.from(Array.from({ length: 4000 }, () => Math.floor(random() * 256)));
    const result = await both(
      () => file("blob.bin", bytes),
      (tools) => tools.read().execute("call_1", { path: "blob.bin" }),
    );
    expect(expectOk(result).content).toHaveLength(1);
    // A text file with an image extension is still text: detection is by content.
    const fake = await both(
      () => file("fake.png", "just text\n"),
      (tools) => tools.read().execute("call_1", { path: "fake.png" }),
    );
    expect(firstText(fake)).toBe("just text\n");
  });

  it("returns images within the limits unchanged, for every supported type", async () => {
    const base = () =>
      sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 90 } },
      });
    const images: Array<{ name: string; mime: string; bytes: Buffer }> = [
      { name: "pic.png", mime: "image/png", bytes: await base().png().toBuffer() },
      { name: "pic.jpg", mime: "image/jpeg", bytes: await base().jpeg().toBuffer() },
      { name: "pic.webp", mime: "image/webp", bytes: await base().webp().toBuffer() },
      { name: "pic.gif", mime: "image/gif", bytes: await base().gif().toBuffer() },
      // Detection is by content, not by extension.
      { name: "picture.txt", mime: "image/png", bytes: await base().png().toBuffer() },
    ];
    for (const image of images) {
      const result = await both(
        () => file(image.name, image.bytes),
        (tools) => tools.read().execute("call_1", { path: image.name }),
      );
      expect(expectOk(result).content, image.name).toStrictEqual([
        { type: "text", text: `Read image file [${image.mime}]` },
        { type: "image", data: image.bytes.toString("base64"), mimeType: image.mime },
      ]);
      expect(expectOk(result).details).toBeUndefined();
    }
  });

  /**
   * Resized images: the encoders differ (sharp here, Photon in pi), so the
   * image bytes are compared by MIME type and decoded size, everything else
   * strictly.
   */
  async function readResized(name: string, bytes: Buffer, options?: ReadToolOptions) {
    const results = {} as Record<Side, { text: string; mimeType: string; data: string }>;
    for (const side of ["pi", "ours"] as const) {
      resetDirs();
      file(name, bytes);
      const result = (await factories(side, cwd).read(options).execute("call_1", {
        path: name,
      })) as unknown as { content: Array<Record<string, string>>; details: unknown };
      expect(result.details).toBeUndefined();
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe("text");
      expect(result.content[1].type).toBe("image");
      results[side] = {
        text: result.content[0].text,
        mimeType: result.content[1].mimeType,
        data: result.content[1].data,
      };
    }
    expect(results.ours.text).toBe(results.pi.text);
    expect(results.ours.mimeType).toBe(results.pi.mimeType);
    const piMeta = await sharp(Buffer.from(results.pi.data, "base64")).metadata();
    const ourMeta = await sharp(Buffer.from(results.ours.data, "base64")).metadata();
    expect({ width: ourMeta.width, height: ourMeta.height, format: ourMeta.format }).toStrictEqual({
      width: piMeta.width,
      height: piMeta.height,
      format: piMeta.format,
    });
    return { ...results.ours, width: ourMeta.width, height: ourMeta.height };
  }

  it("downscales an oversized image to the same size with the same note", async () => {
    const wide = await sharp({
      create: { width: 2400, height: 1300, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const result = await readResized("wide.png", wide);
    expect(result.text).toBe(
      "Read image file [image/png]\n[Image: original 2400x1300, displayed at 2000x1083. Multiply coordinates by 1.20 to map to original image.]",
    );
    expect({ width: result.width, height: result.height }).toStrictEqual({
      width: 2000,
      height: 1083,
    });

    const tall = await sharp({
      create: {
        width: 900,
        height: 2700,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const tallResult = await readResized("tall.png", tall);
    expect({ width: tallResult.width, height: tallResult.height }).toStrictEqual({
      width: 667,
      height: 2000,
    });
  });

  it("applies the EXIF orientation of a JPEG before measuring and resizing", async () => {
    const rotated = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: { r: 90, g: 90, b: 20 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);
    const result = await readResized("rotated.jpg", rotated);
    expect(result.text).toBe(
      "Read image file [image/png]\n[Image: original 1200x2400, displayed at 1000x2000. Multiply coordinates by 1.20 to map to original image.]",
    );
  });

  it("passes an oversized image through untouched when autoResizeImages is off", async () => {
    const wide = await sharp({
      create: { width: 2400, height: 1300, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const result = await both(
      () => file("wide.png", wide),
      (tools) => tools.read({ autoResizeImages: false }).execute("call_1", { path: "wide.png" }),
    );
    expect(expectOk(result).content).toStrictEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: wide.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("omits an image whose pixel data cannot be decoded", async () => {
    const good = await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    // Valid signature and header, pixel data cut off.
    const broken = good.subarray(0, 60);
    const result = await both(
      () => file("broken.png", broken),
      (tools) => tools.read().execute("call_1", { path: "broken.png" }),
    );
    expect(expectOk(result).content).toStrictEqual([
      {
        type: "text",
        text: "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
      },
    ]);
  });

  it("resolves relative, absolute, home and @ paths the same way", async () => {
    const relative = await both(
      () => file("dir/sub/a.txt", "relative\n"),
      (tools) => tools.read().execute("call_1", { path: "dir/sub/../sub/a.txt" }),
    );
    expect(firstText(relative)).toBe("relative\n");

    const absolute = await both(
      () => fs.writeFileSync(path.join(root, "home", "abs.txt"), "absolute\n"),
      (tools) => tools.read().execute("call_1", { path: path.join(root, "home", "abs.txt") }),
    );
    expect(firstText(absolute)).toBe("absolute\n");

    const tilde = await both(
      () => fs.writeFileSync(path.join(home, "in-home.txt"), "home\n"),
      (tools) => tools.read().execute("call_1", { path: "~/in-home.txt" }),
    );
    expect(firstText(tilde)).toBe("home\n");

    const at = await both(
      () => file("mention.txt", "at\n"),
      (tools) => tools.read().execute("call_1", { path: "@mention.txt" }),
    );
    expect(firstText(at)).toBe("at\n");

    // "~" alone is the home directory: reading it fails the same way on both sides.
    expectError(
      await both(undefined, (tools) => tools.read().execute("call_1", { path: "~" })),
      /EISDIR/,
    );
    // "~user" is not expanded.
    expectError(
      await both(undefined, (tools) => tools.read().execute("call_1", { path: "~nobody/x.txt" })),
      /ENOENT/,
    );
  });

  it("finds the macOS filename variants (narrow space, NFD, curly apostrophe)", async () => {
    const narrow = await both(
      () => file("Screenshot 2026-01-01 at 1.00.00\u202FPM.txt", "narrow\n"),
      (tools) =>
        tools.read().execute("call_1", { path: "Screenshot 2026-01-01 at 1.00.00 PM.txt" }),
    );
    expect(firstText(narrow)).toBe("narrow\n");

    const nfd = await both(
      () => file("cafe\u0301.txt", "nfd\n"),
      (tools) => tools.read().execute("call_1", { path: "caf\u00E9.txt" }),
    );
    expect(firstText(nfd)).toBe("nfd\n");

    const curly = await both(
      () => file("Capture d\u2019ecran.txt", "curly\n"),
      (tools) => tools.read().execute("call_1", { path: "Capture d'ecran.txt" }),
    );
    expect(firstText(curly)).toBe("curly\n");

    const combined = await both(
      () => file("Capture d\u2019e\u0301cran.txt", "combined\n"),
      (tools) => tools.read().execute("call_1", { path: "Capture d'\u00E9cran.txt" }),
    );
    expect(firstText(combined)).toBe("combined\n");

    // A no-break space in the requested path is read as a plain space.
    const nbsp = await both(
      () => file("my file.txt", "nbsp\n"),
      (tools) => tools.read().execute("call_1", { path: "my\u00A0file.txt" }),
    );
    expect(firstText(nbsp)).toBe("nbsp\n");
  });

  it("rejects when the signal is already aborted, and when it aborts mid-read", async () => {
    const pre = await both(
      () => file("a.txt", "x\n"),
      (tools) => {
        const controller = new AbortController();
        controller.abort();
        return tools.read().execute("call_1", { path: "a.txt" }, controller.signal);
      },
    );
    expectError(pre, "Operation aborted");

    const mid = await both(
      () => file("a.txt", "x\n"),
      (tools, extra) => {
        const controller = new AbortController();
        const operations: ReadOperations = {
          access: async (absolutePath) => {
            extra.push(["access", absolutePath]);
            controller.abort();
          },
          readFile: async (absolutePath) => {
            extra.push(["readFile", absolutePath]);
            return Buffer.from("never");
          },
        };
        return tools.read({ operations }).execute("call_1", { path: "a.txt" }, controller.signal);
      },
    );
    expectError(mid, "Operation aborted");
    expect(mid.extra).toStrictEqual([["access", path.join(cwd, "a.txt")]]);
  });

  it("goes through custom operations with the same calls", async () => {
    const png = await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const makeOps = (
      extra: unknown[],
      store: Record<string, Buffer>,
      detect: "none" | "png" | "null",
    ): ReadOperations => ({
      access: async (absolutePath) => {
        extra.push(["access", absolutePath]);
        if (!(absolutePath in store)) {
          throw Object.assign(new Error(`no such entry: ${absolutePath}`), { code: "ENOENT" });
        }
      },
      readFile: async (absolutePath) => {
        extra.push(["readFile", absolutePath]);
        return store[absolutePath];
      },
      ...(detect === "none"
        ? {}
        : {
            detectImageMimeType: async (absolutePath: string) => {
              extra.push(["detectImageMimeType", absolutePath]);
              return detect === "png" && absolutePath.endsWith(".png") ? "image/png" : null;
            },
          }),
    });
    const virtual = (rel: string) => path.join(cwd, rel);

    const text = await both(undefined, (tools, extra) =>
      tools
        .read({
          operations: makeOps(extra, { [virtual("v.txt")]: Buffer.from(lines(30)) }, "none"),
        })
        .execute("call_1", { path: "v.txt", offset: 3, limit: 4 }),
    );
    expect(firstText(text)).toMatch(/^line 3\nline 4\nline 5\nline 6\n\n\[24 more lines/);
    expect(text.extra).toStrictEqual([
      ["access", virtual("v.txt")],
      ["readFile", virtual("v.txt")],
    ]);

    const image = await both(undefined, (tools, extra) =>
      tools
        .read({ operations: makeOps(extra, { [virtual("v.png")]: png }, "png") })
        .execute("call_1", { path: "v.png" }),
    );
    expect(expectOk(image).content).toStrictEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    expect(image.extra).toStrictEqual([
      ["access", virtual("v.png")],
      ["detectImageMimeType", virtual("v.png")],
      ["readFile", virtual("v.png")],
    ]);

    // Without detectImageMimeType (or when it answers null) image bytes are read as text.
    for (const detect of ["none", "null"] as const) {
      const asText = await both(undefined, (tools, extra) =>
        tools
          .read({ operations: makeOps(extra, { [virtual("v.png")]: png }, detect) })
          .execute("call_1", { path: "v.png" }),
      );
      expect(expectOk(asText).content).toHaveLength(1);
    }

    const missing = await both(undefined, (tools, extra) =>
      tools.read({ operations: makeOps(extra, {}, "png") }).execute("call_1", { path: "nope.txt" }),
    );
    expectError(missing, `no such entry: ${virtual("nope.txt")}`);
    expect((missing.outcome as { code: unknown }).code).toBe("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("write vs pi", () => {
  it("creates, overwrites and nests", async () => {
    const created = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "new.txt", content: "hello\n" }),
    );
    expect(expectOk(created)).toStrictEqual({
      content: [{ type: "text", text: "Successfully wrote 6 bytes to new.txt" }],
      details: undefined,
    });
    expect(created.tree["ws/new.txt"]).toBe(`file:${Buffer.from("hello\n").toString("base64")}`);

    const overwritten = await both(
      () => file("old.txt", "a much longer previous content\n"),
      (tools) => tools.write().execute("call_1", { path: "old.txt", content: "short" }),
    );
    expect(overwritten.tree["ws/old.txt"]).toBe(`file:${Buffer.from("short").toString("base64")}`);

    const nested = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "a/b/c/deep.txt", content: "deep" }),
    );
    expect(nested.tree["ws/a/b/c/deep.txt"]).toBe(`file:${Buffer.from("deep").toString("base64")}`);

    const empty = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "empty.txt", content: "" }),
    );
    expect(firstText(empty)).toBe("Successfully wrote 0 bytes to empty.txt");
  });

  it("reports the length in UTF-16 units and writes UTF-8", async () => {
    const content = "é漢🙂\r\n";
    const result = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "utf8.txt", content }),
    );
    expect(firstText(result)).toBe(`Successfully wrote ${content.length} bytes to utf8.txt`);
    expect(result.tree["ws/utf8.txt"]).toBe(
      `file:${Buffer.from(content, "utf-8").toString("base64")}`,
    );
  });

  it("resolves absolute, home and @ paths the same way", async () => {
    const absolute = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: path.join(home, "x", "abs.txt"), content: "abs" }),
    );
    expect(absolute.tree["home/x/abs.txt"]).toBeDefined();
    expect(firstText(absolute)).toBe(
      `Successfully wrote 3 bytes to ${path.join(home, "x", "abs.txt")}`,
    );

    const tilde = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "~/notes/t.txt", content: "tilde" }),
    );
    expect(tilde.tree["home/notes/t.txt"]).toBeDefined();

    const at = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "@at.txt", content: "at" }),
    );
    expect(at.tree["ws/at.txt"]).toBeDefined();

    const parent = await both(undefined, (tools) =>
      tools.write().execute("call_1", { path: "../home/up.txt", content: "up" }),
    );
    expect(parent.tree["home/up.txt"]).toBeDefined();
  });

  it("fails the same way on a directory target, a file parent and bad arguments", async () => {
    expectError(
      await both(
        () => fs.mkdirSync(path.join(cwd, "folder")),
        (tools) => tools.write().execute("call_1", { path: "folder", content: "x" }),
      ),
      /EISDIR/,
    );
    expectError(
      await both(
        () => file("plain.txt", "i am a file"),
        (tools) => tools.write().execute("call_1", { path: "plain.txt/child.txt", content: "x" }),
      ),
      /ENOTDIR|EEXIST/,
    );
    for (const args of [
      {},
      undefined,
      null,
      { path: "a.txt" },
      { content: "x" },
      { path: 5, content: "x" },
    ]) {
      const result = await both(undefined, (tools) => tools.write().execute("call_1", args));
      expect(result.outcome.ok, JSON.stringify(args)).toBe(false);
      expect((result.outcome as { sync: boolean }).sync).toBe(false);
    }
  });

  it("rejects when aborted before or during the write", async () => {
    const pre = await both(undefined, (tools) => {
      const controller = new AbortController();
      controller.abort();
      return tools.write().execute("call_1", { path: "a.txt", content: "x" }, controller.signal);
    });
    expectError(pre, "Operation aborted");
    expect(pre.tree["ws/a.txt"]).toBeUndefined();

    const mid = await both(undefined, (tools, extra) => {
      const controller = new AbortController();
      const operations: WriteOperations = {
        mkdir: async (dir) => {
          extra.push(["mkdir", dir]);
          controller.abort();
        },
        writeFile: async (absolutePath, content) => {
          extra.push(["writeFile", absolutePath, content]);
        },
      };
      return tools
        .write({ operations })
        .execute("call_1", { path: "a.txt", content: "x" }, controller.signal);
    });
    expectError(mid, "Operation aborted");
    expect(mid.extra).toStrictEqual([["mkdir", cwd]]);
  });

  it("goes through custom operations with the same calls", async () => {
    const result = await both(undefined, (tools, extra) => {
      const operations: WriteOperations = {
        mkdir: async (dir) => {
          extra.push(["mkdir", dir]);
        },
        writeFile: async (absolutePath, content) => {
          extra.push(["writeFile", absolutePath, content]);
        },
      };
      return tools
        .write({ operations })
        .execute("call_1", { path: "virtual/dir/v.txt", content: "payload" });
    });
    expect(firstText(result)).toBe("Successfully wrote 7 bytes to virtual/dir/v.txt");
    expect(result.extra).toStrictEqual([
      ["mkdir", path.join(cwd, "virtual", "dir")],
      ["writeFile", path.join(cwd, "virtual", "dir", "v.txt"), "payload"],
    ]);
    // Nothing touched the real filesystem.
    expect(result.tree["ws/virtual/"]).toBeUndefined();

    const failing = await both(undefined, (tools) => {
      const operations: WriteOperations = {
        mkdir: async () => {},
        writeFile: async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      };
      return tools.write({ operations }).execute("call_1", { path: "v.txt", content: "x" });
    });
    expectError(failing, "disk full");
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("edit vs pi", () => {
  const edit = (tools: Factories, args: unknown) => tools.edit().execute("call_1", args);

  it("applies a single edit", async () => {
    const result = await both(
      () => file("note.txt", "alpha beta gamma\nsecond line\n"),
      (tools) => edit(tools, { path: "note.txt", edits: [{ oldText: "beta", newText: "BETA" }] }),
    );
    expect(expectOk(result)).toStrictEqual({
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in note.txt." }],
      details: {
        diff: "-1 alpha beta gamma\n+1 alpha BETA gamma\n 2 second line",
        firstChangedLine: 1,
      },
    });
    expect(result.tree["ws/note.txt"]).toBe(
      `file:${Buffer.from("alpha BETA gamma\nsecond line\n").toString("base64")}`,
    );
  });

  it("applies multiple edits against the original content, in any order", async () => {
    const result = await both(
      () => file("multi.txt", lines(40)),
      (tools) =>
        edit(tools, {
          path: "multi.txt",
          edits: [
            { oldText: "line 30\n", newText: "" },
            { oldText: "line 2\n", newText: "line two\nline two and a half\n" },
            { oldText: "line 17", newText: "line seventeen" },
            { oldText: "line 40", newText: "line 40\nline 41" },
          ],
        }),
    );
    expect(firstText(result)).toBe("Successfully replaced 4 block(s) in multi.txt.");
    expect((expectOk(result).details as { diff: string }).diff).toContain("...");
  });

  it("produces the same diff for edits at the edges and without a trailing newline", async () => {
    const scenarios: Array<{
      content: string;
      edits: Array<{ oldText: string; newText: string }>;
    }> = [
      { content: lines(30), edits: [{ oldText: "line 1\n", newText: "first\n" }] },
      { content: lines(30), edits: [{ oldText: "line 30", newText: "last" }] },
      { content: `${lines(30)}\n`, edits: [{ oldText: "line 30\n", newText: "last\n" }] },
      { content: lines(30), edits: [{ oldText: "line 30", newText: "line 30\n" }] },
      { content: `${lines(30)}\n`, edits: [{ oldText: "line 30\n", newText: "line 30" }] },
      { content: "single", edits: [{ oldText: "single", newText: "double" }] },
      { content: "a\n\n\nb\n", edits: [{ oldText: "\n\n\n", newText: "\n" }] },
      { content: lines(12), edits: [{ oldText: "line 6\n", newText: "" }] },
      {
        content: lines(1200),
        edits: [
          { oldText: "line 5\n", newText: "five\n" },
          { oldText: "line 14\n", newText: "fourteen\n" },
          { oldText: "line 1100\n", newText: "eleven hundred\nand more\n" },
        ],
      },
      {
        content: lines(20, (i) => (i % 2 ? "same" : `row ${i}`)),
        edits: [{ oldText: "row 10\nsame\nrow 12", newText: "row 10\nrow 12" }],
      },
    ];
    for (const scenario of scenarios) {
      const result = await both(
        () => file("edge.txt", scenario.content),
        (tools) => edit(tools, { path: "edge.txt", edits: scenario.edits }),
      );
      expect(result.outcome.ok, JSON.stringify(scenario.edits)).toBe(true);
    }
  });

  it("reports text that is not found", async () => {
    expectError(
      await both(
        () => file("note.txt", "alpha beta gamma\n"),
        (tools) => edit(tools, { path: "note.txt", edits: [{ oldText: "delta", newText: "x" }] }),
      ),
      "Could not find the exact text in note.txt. The old text must match exactly including all whitespace and newlines.",
    );
    const multi = await both(
      () => file("note.txt", "alpha beta gamma\n"),
      (tools) =>
        edit(tools, {
          path: "note.txt",
          edits: [
            { oldText: "alpha", newText: "A" },
            { oldText: "delta", newText: "x" },
          ],
        }),
    );
    expectError(
      multi,
      "Could not find edits[1] in note.txt. The oldText must match exactly including all whitespace and newlines.",
    );
    // Nothing was written.
    expect(multi.tree["ws/note.txt"]).toBe(
      `file:${Buffer.from("alpha beta gamma\n").toString("base64")}`,
    );
  });

  it("reports text that matches more than once", async () => {
    expectError(
      await both(
        () => file("dup.txt", "one two one two one\n"),
        (tools) => edit(tools, { path: "dup.txt", edits: [{ oldText: "one", newText: "1" }] }),
      ),
      "Found 3 occurrences of the text in dup.txt. The text must be unique. Please provide more context to make it unique.",
    );
    expectError(
      await both(
        () => file("dup.txt", "one two one two one\n"),
        (tools) =>
          edit(tools, {
            path: "dup.txt",
            edits: [
              { oldText: "one two one two", newText: "x" },
              { oldText: "two", newText: "2" },
            ],
          }),
      ),
      "Found 2 occurrences of edits[1] in dup.txt. Each oldText must be unique. Please provide more context to make it unique.",
    );
  });

  it("reports overlapping edits", async () => {
    expectError(
      await both(
        () => file("overlap.txt", "abcdefghij\n"),
        (tools) =>
          edit(tools, {
            path: "overlap.txt",
            edits: [
              { oldText: "defg", newText: "X" },
              { oldText: "bcde", newText: "Y" },
            ],
          }),
      ),
      "edits[1] and edits[0] overlap in overlap.txt. Merge them into one edit or target disjoint regions.",
    );
    // Nested edit.
    expectError(
      await both(
        () => file("overlap.txt", "abcdefghij\n"),
        (tools) =>
          edit(tools, {
            path: "overlap.txt",
            edits: [
              { oldText: "bcdefgh", newText: "X" },
              { oldText: "def", newText: "Y" },
            ],
          }),
      ),
      /overlap in overlap\.txt/,
    );
    // Touching but not overlapping edits are fine.
    const adjacent = await both(
      () => file("overlap.txt", "abcdefghij\n"),
      (tools) =>
        edit(tools, {
          path: "overlap.txt",
          edits: [
            { oldText: "abc", newText: "1" },
            { oldText: "def", newText: "2" },
          ],
        }),
    );
    expect(adjacent.tree["ws/overlap.txt"]).toBe(
      `file:${Buffer.from("12ghij\n").toString("base64")}`,
    );
  });

  it("keeps CRLF line endings, whichever ending oldText uses", async () => {
    for (const oldText of ["two\nthree", "two\r\nthree"]) {
      const result = await both(
        () => file("crlf.txt", "one\r\ntwo\r\nthree\r\nfour\r\n"),
        (tools) => edit(tools, { path: "crlf.txt", edits: [{ oldText, newText: "2\n3\nextra" }] }),
      );
      expect(result.tree["ws/crlf.txt"]).toBe(
        `file:${Buffer.from("one\r\n2\r\n3\r\nextra\r\nfour\r\n").toString("base64")}`,
      );
    }
    // Mixed endings: the first one found decides. Lone CR becomes the file's ending.
    for (const content of ["a\nb\r\nc\rd\n", "a\r\nb\nc\rd\n", "a\rb\rc\r"]) {
      const result = await both(
        () => file("mixed.txt", content),
        (tools) => edit(tools, { path: "mixed.txt", edits: [{ oldText: "b", newText: "B" }] }),
      );
      expect(result.outcome.ok, JSON.stringify(content)).toBe(true);
    }
  });

  it("keeps a UTF-8 BOM and matches as if it were not there", async () => {
    const result = await both(
      () => file("bom.txt", "\uFEFFfirst line\nsecond line\n"),
      (tools) =>
        edit(tools, { path: "bom.txt", edits: [{ oldText: "first line", newText: "FIRST" }] }),
    );
    expect(result.tree["ws/bom.txt"]).toBe(
      `file:${Buffer.from("\uFEFFFIRST\nsecond line\n").toString("base64")}`,
    );
    const crlfBom = await both(
      () => file("bom.txt", "\uFEFFfirst\r\nsecond\r\n"),
      (tools) => edit(tools, { path: "bom.txt", edits: [{ oldText: "second", newText: "2nd" }] }),
    );
    expect(crlfBom.tree["ws/bom.txt"]).toBe(
      `file:${Buffer.from("\uFEFFfirst\r\n2nd\r\n").toString("base64")}`,
    );
  });

  it("falls back to fuzzy matching for trailing whitespace, quotes, dashes and spaces", async () => {
    const trailing = await both(
      () => file("ws.txt", "keep   \nfunction a() {   \n  return 1;\t\n}\nlast  \n"),
      (tools) =>
        edit(tools, {
          path: "ws.txt",
          edits: [
            {
              oldText: "function a() {\n  return 1;\n}",
              newText: "function a() {\n  return 2;\n}",
            },
          ],
        }),
    );
    // Fuzzy matching rewrites the whole file in normalized form.
    expect(trailing.tree["ws/ws.txt"]).toBe(
      `file:${Buffer.from("keep\nfunction a() {\n  return 2;\n}\nlast\n").toString("base64")}`,
    );

    const typography = await both(
      () =>
        file("typo.txt", "She said \u201Chello\u201D \u2014 it\u2019s 5\u00A0km\u2026 \uFB01ne\n"),
      (tools) =>
        edit(tools, {
          path: "typo.txt",
          edits: [{ oldText: 'said "hello" - it\'s 5 km', newText: "wrote" }],
        }),
    );
    expect(typography.outcome.ok).toBe(true);

    // One exact and one fuzzy edit in the same call.
    const mixed = await both(
      () => file("mixed.txt", "exact one\nfuzzy two   \nthree\n"),
      (tools) =>
        edit(tools, {
          path: "mixed.txt",
          edits: [
            { oldText: "exact one", newText: "EXACT" },
            { oldText: "fuzzy two\nthree", newText: "FUZZY\nthree" },
          ],
        }),
    );
    expect(mixed.outcome.ok).toBe(true);

    // Duplicates are counted in fuzzy space even when the exact text is unique.
    expectError(
      await both(
        () => file("fuzzydup.txt", "value  \nvalue\n"),
        (tools) =>
          edit(tools, { path: "fuzzydup.txt", edits: [{ oldText: "value  \n", newText: "x\n" }] }),
      ),
      /Found 2 occurrences of the text in fuzzydup\.txt/,
    );
  });

  it("rejects empty oldText, no-op edits and invalid input", async () => {
    const setup = () => file("note.txt", "alpha beta gamma\n");
    expectError(
      await both(setup, (tools) =>
        edit(tools, { path: "note.txt", edits: [{ oldText: "", newText: "x" }] }),
      ),
      "oldText must not be empty in note.txt.",
    );
    expectError(
      await both(setup, (tools) =>
        edit(tools, {
          path: "note.txt",
          edits: [
            { oldText: "alpha", newText: "A" },
            { oldText: "", newText: "x" },
          ],
        }),
      ),
      "edits[1].oldText must not be empty in note.txt.",
    );
    expectError(
      await both(setup, (tools) =>
        edit(tools, { path: "note.txt", edits: [{ oldText: "beta", newText: "beta" }] }),
      ),
      "No changes made to note.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
    );
    expectError(
      await both(setup, (tools) =>
        edit(tools, {
          path: "note.txt",
          edits: [
            { oldText: "alpha", newText: "alpha" },
            { oldText: "beta", newText: "beta" },
          ],
        }),
      ),
      "No changes made to note.txt. The replacements produced identical content.",
    );
    for (const args of [
      { path: "note.txt", edits: [] },
      { path: "note.txt" },
      { path: "note.txt", edits: "beta" },
      { path: "note.txt", oldText: "beta", newText: "BETA" },
    ]) {
      expectError(
        await both(setup, (tools) => edit(tools, args)),
        "Edit tool input is invalid. edits must contain at least one replacement.",
      );
    }
    for (const args of [
      undefined,
      null,
      {},
      { edits: [{ oldText: "a", newText: "b" }] },
      { path: "note.txt", edits: [null] },
      { path: "note.txt", edits: [{ oldText: "beta" }] },
    ]) {
      const result = await both(setup, (tools) => edit(tools, args));
      expect(result.outcome.ok, JSON.stringify(args)).toBe(false);
      expect((result.outcome as { sync: boolean }).sync).toBe(false);
    }
  });

  it("accepts the legacy argument shape through prepareArguments", async () => {
    const result = await both(
      () => file("note.txt", "alpha beta gamma\n"),
      (tools) => {
        const tool = tools.edit();
        const prepared = tool.prepareArguments?.({
          path: "note.txt",
          oldText: "gamma",
          newText: "GAMMA",
        }) as unknown;
        return tool.execute("call_1", prepared);
      },
    );
    expect(result.tree["ws/note.txt"]).toBe(
      `file:${Buffer.from("alpha beta GAMMA\n").toString("base64")}`,
    );
    const asString = await both(
      () => file("note.txt", "alpha beta gamma\n"),
      (tools) => {
        const tool = tools.edit();
        const prepared = tool.prepareArguments?.({
          path: "note.txt",
          edits: JSON.stringify([{ oldText: "alpha", newText: "ALPHA" }]),
          oldText: "gamma",
          newText: "GAMMA",
        }) as unknown;
        return tool.execute("call_1", prepared);
      },
    );
    expect(asString.tree["ws/note.txt"]).toBe(
      `file:${Buffer.from("ALPHA beta GAMMA\n").toString("base64")}`,
    );
  });

  it("fails the same way on a missing file, a directory and a read-only file", async () => {
    expectError(
      await both(undefined, (tools) =>
        edit(tools, { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }),
      ),
      "Could not edit file: missing.txt. Error code: ENOENT.",
    );
    expectError(
      await both(
        () => fs.mkdirSync(path.join(cwd, "folder")),
        (tools) => edit(tools, { path: "folder", edits: [{ oldText: "a", newText: "b" }] }),
      ),
      /EISDIR/,
    );
    if (process.getuid?.() !== 0) {
      expectError(
        await both(
          () => {
            file("locked.txt", "alpha\n");
            fs.chmodSync(path.join(cwd, "locked.txt"), 0o444);
          },
          (tools) =>
            edit(tools, { path: "locked.txt", edits: [{ oldText: "alpha", newText: "b" }] }),
        ),
        "Could not edit file: locked.txt. Error code: EACCES.",
      );
    }
  });

  it("resolves absolute, home and @ paths the same way", async () => {
    const absolute = await both(
      () => fs.writeFileSync(path.join(home, "abs.txt"), "alpha\n"),
      (tools) =>
        edit(tools, {
          path: path.join(home, "abs.txt"),
          edits: [{ oldText: "alpha", newText: "A" }],
        }),
    );
    expect(firstText(absolute)).toBe(
      `Successfully replaced 1 block(s) in ${path.join(home, "abs.txt")}.`,
    );
    const tilde = await both(
      () => fs.writeFileSync(path.join(home, "t.txt"), "alpha\n"),
      (tools) => edit(tools, { path: "~/t.txt", edits: [{ oldText: "alpha", newText: "A" }] }),
    );
    expect(tilde.tree["home/t.txt"]).toBe(`file:${Buffer.from("A\n").toString("base64")}`);
    const at = await both(
      () => file("at.txt", "alpha\n"),
      (tools) => edit(tools, { path: "@at.txt", edits: [{ oldText: "alpha", newText: "A" }] }),
    );
    expect(at.tree["ws/at.txt"]).toBe(`file:${Buffer.from("A\n").toString("base64")}`);
  });

  it("rejects when aborted before, during the read and during the write", async () => {
    const pre = await both(
      () => file("a.txt", "alpha\n"),
      (tools) => {
        const controller = new AbortController();
        controller.abort();
        return tools
          .edit()
          .execute(
            "call_1",
            { path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }] },
            controller.signal,
          );
      },
    );
    expectError(pre, "Operation aborted");
    expect(pre.tree["ws/a.txt"]).toBe(`file:${Buffer.from("alpha\n").toString("base64")}`);

    for (const abortAt of ["access", "readFile", "writeFile"] as const) {
      const mid = await both(undefined, (tools, extra) => {
        const controller = new AbortController();
        const step = (name: string) => {
          extra.push(name);
          if (name === abortAt) {
            controller.abort();
          }
        };
        const operations: EditOperations = {
          access: async () => step("access"),
          readFile: async () => {
            step("readFile");
            return Buffer.from("alpha\n");
          },
          writeFile: async () => step("writeFile"),
        };
        return tools
          .edit({ operations })
          .execute(
            "call_1",
            { path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }] },
            controller.signal,
          );
      });
      expectError(mid, "Operation aborted");
    }
  });

  it("goes through custom operations with the same calls", async () => {
    const makeOps = (extra: unknown[], store: Record<string, string>): EditOperations => ({
      access: async (absolutePath) => {
        extra.push(["access", absolutePath]);
        if (!(absolutePath in store)) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
      },
      readFile: async (absolutePath) => {
        extra.push(["readFile", absolutePath]);
        return Buffer.from(store[absolutePath], "utf-8");
      },
      writeFile: async (absolutePath, content) => {
        extra.push(["writeFile", absolutePath, content]);
        store[absolutePath] = content;
      },
    });
    const virtual = path.join(cwd, "v.txt");
    const result = await both(undefined, (tools, extra) =>
      tools
        .edit({ operations: makeOps(extra, { [virtual]: "\uFEFFone\r\ntwo\r\n" }) })
        .execute("call_1", { path: "v.txt", edits: [{ oldText: "two", newText: "2" }] }),
    );
    expect(result.extra).toStrictEqual([
      ["access", virtual],
      ["readFile", virtual],
      ["writeFile", virtual, "\uFEFFone\r\n2\r\n"],
    ]);

    const missing = await both(undefined, (tools, extra) =>
      tools
        .edit({ operations: makeOps(extra, {}) })
        .execute("call_1", { path: "v.txt", edits: [{ oldText: "two", newText: "2" }] }),
    );
    expectError(missing, "Could not edit file: v.txt. Error code: ENOENT.");

    // An access failure that is not an Error with a code is stringified.
    const odd = await both(undefined, (tools) => {
      const operations: EditOperations = {
        access: async () => {
          throw "plain string failure";
        },
        readFile: async () => Buffer.from(""),
        writeFile: async () => {},
      };
      return tools
        .edit({ operations })
        .execute("call_1", { path: "v.txt", edits: [{ oldText: "two", newText: "2" }] });
    });
    expectError(odd, "Could not edit file: v.txt. plain string failure.");

    const noCode = await both(undefined, (tools) => {
      const operations: EditOperations = {
        access: async () => {
          throw new Error("no code here");
        },
        readFile: async () => Buffer.from(""),
        writeFile: async () => {},
      };
      return tools
        .edit({ operations })
        .execute("call_1", { path: "v.txt", edits: [{ oldText: "two", newText: "2" }] });
    });
    expectError(noCode, "Could not edit file: v.txt. Error: no code here.");
  });

  it("matches pi on random edits (fuzz, in-memory operations)", async () => {
    const random = prng(20261001);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const words = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "x",
      "",
      "  ",
      "end;",
      "\u201Cq\u201D",
      "a\u2014b",
    ];
    const eols = ["\n", "\n", "\n", "\r\n", "   \n"];
    let succeeded = 0;
    let failed = 0;
    for (let round = 0; round < 250; round++) {
      const lineCount = 1 + Math.floor(random() * 30);
      let content = random() < 0.1 ? "\uFEFF" : "";
      for (let i = 0; i < lineCount; i++) {
        content += `${pick(words)} ${pick(words)} ${i % 7}${pick(eols)}`;
      }
      const editCount = 1 + Math.floor(random() * 3);
      const edits = Array.from({ length: editCount }, () => {
        const start = Math.floor(random() * content.length);
        const length = 1 + Math.floor(random() * 25);
        let oldText = content.slice(start, start + length);
        if (random() < 0.2) {
          oldText = oldText.trimEnd();
        }
        if (random() < 0.1) {
          oldText = pick(words);
        }
        return {
          oldText,
          newText: random() < 0.2 ? "" : `${pick(words)}${pick(eols)}${pick(words)}`,
        };
      });
      const run = async (tool: AnyAgentTool) => {
        return settle(() =>
          tool.execute("call_1", { path: "f.txt", edits: structuredClone(edits) }),
        );
      };
      const store = { pi: content, ours: content };
      const ops = (side: Side): EditOperations => ({
        access: async () => {},
        readFile: async () => Buffer.from(store[side], "utf-8"),
        writeFile: async (_path, next) => {
          store[side] = next;
        },
      });
      const pi = await run(
        piCreateEditTool("/virtual", { operations: ops("pi") }) as unknown as AnyAgentTool,
      );
      const ours = await run(createEditTool("/virtual", { operations: ops("ours") }));
      const label = JSON.stringify({ content, edits });
      expect(ours, label).toStrictEqual(pi);
      expect(store.ours, label).toBe(store.pi);
      if (ours.ok) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
    // Guard against a vacuous comparison: both outcomes were exercised.
    expect(succeeded).toBeGreaterThan(20);
    expect(failed).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// Serialization per path
// ---------------------------------------------------------------------------

describe("file mutation queue vs pi", () => {
  it("applies concurrent edits to one file without losing any", async () => {
    const count = 12;
    const result = await both(
      () =>
        file(
          "shared.txt",
          lines(count, (i) => `slot-${i};`),
        ),
      (tools) =>
        Promise.all(
          Array.from({ length: count }, (_, i) =>
            tools.edit().execute(`call_${i}`, {
              path: "shared.txt",
              edits: [{ oldText: `slot-${i + 1};`, newText: `done-${i + 1};` }],
            }),
          ),
        ),
    );
    expect(result.outcome.ok).toBe(true);
    expect(result.tree["ws/shared.txt"]).toBe(
      `file:${Buffer.from(lines(count, (i) => `done-${i};`)).toString("base64")}`,
    );
  });

  it("applies concurrent writes and edits to one file in call order", async () => {
    const result = await both(
      () => file("shared.txt", "start\n"),
      (tools) =>
        Promise.all([
          tools.write().execute("w1", { path: "shared.txt", content: "one\n" }),
          tools
            .edit()
            .execute("e1", { path: "shared.txt", edits: [{ oldText: "one", newText: "two" }] }),
          tools
            .edit()
            .execute("e2", { path: "./shared.txt", edits: [{ oldText: "two", newText: "three" }] }),
          tools
            .write()
            .execute("w2", { path: path.join(cwd, "shared.txt"), content: "four three\n" }),
          tools
            .edit()
            .execute("e3", { path: "shared.txt", edits: [{ oldText: "three", newText: "five" }] }),
        ]),
    );
    expect(result.outcome.ok).toBe(true);
    expect(result.tree["ws/shared.txt"]).toBe(
      `file:${Buffer.from("four five\n").toString("base64")}`,
    );
  });

  it("runs slow operations on one path one at a time, and different paths in parallel", async () => {
    const result = await both(undefined, async (tools, extra) => {
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const operations: WriteOperations = {
        mkdir: async () => {},
        writeFile: async (absolutePath, content) => {
          extra.push(`start ${path.basename(absolutePath)} ${content}`);
          await delay(content === "slow" ? 40 : 5);
          extra.push(`end ${path.basename(absolutePath)} ${content}`);
        },
      };
      const tool = tools.write({ operations });
      await Promise.all([
        tool.execute("1", { path: "same.txt", content: "slow" }),
        tool.execute("2", { path: "same.txt", content: "fast" }),
        tool.execute("3", { path: "same.txt", content: "last" }),
      ]);
      extra.push("---");
      await Promise.all([
        tool.execute("4", { path: "a.txt", content: "slow" }),
        tool.execute("5", { path: "b.txt", content: "fast" }),
      ]);
    });
    expect(result.extra).toStrictEqual([
      "start same.txt slow",
      "end same.txt slow",
      "start same.txt fast",
      "end same.txt fast",
      "start same.txt last",
      "end same.txt last",
      "---",
      "start a.txt slow",
      "start b.txt fast",
      "end b.txt fast",
      "end a.txt slow",
    ]);
  });

  it("keeps the queue moving after a failed operation", async () => {
    const result = await both(
      () => file("shared.txt", "alpha\n"),
      async (tools) => {
        const outcomes = await Promise.allSettled([
          tools
            .edit()
            .execute("e1", { path: "shared.txt", edits: [{ oldText: "missing", newText: "x" }] }),
          tools
            .edit()
            .execute("e2", { path: "shared.txt", edits: [{ oldText: "alpha", newText: "beta" }] }),
        ]);
        return outcomes.map((outcome) => outcome.status);
      },
    );
    expect(result.outcome).toStrictEqual({ ok: true, value: ["rejected", "fulfilled"] });
    expect(result.tree["ws/shared.txt"]).toBe(`file:${Buffer.from("beta\n").toString("base64")}`);
  });

  it("queues a symlink and its target together", async () => {
    const order = async (queue: typeof withFileMutationQueue) => {
      resetDirs();
      file("target.txt", "x");
      fs.symlinkSync(path.join(cwd, "target.txt"), path.join(cwd, "link.txt"));
      const events: string[] = [];
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      await Promise.all([
        queue(path.join(cwd, "target.txt"), async () => {
          events.push("target start");
          await delay(30);
          events.push("target end");
        }),
        queue(path.join(cwd, "link.txt"), async () => {
          events.push("link start");
          events.push("link end");
        }),
        queue(path.join(cwd, "not-there.txt"), async () => {
          events.push("other");
        }),
      ]);
      return events;
    };
    const ours = await order(withFileMutationQueue);
    expect(ours).toStrictEqual(await order(piWithFileMutationQueue));
    expect(ours).toStrictEqual(["target start", "other", "target end", "link start", "link end"]);
  });
});

// ---------------------------------------------------------------------------
// Helpers: truncation, paths, diff
// ---------------------------------------------------------------------------

describe("helpers vs pi", () => {
  it("has the same limits and size format", () => {
    expect(DEFAULT_MAX_LINES).toBe(PI_DEFAULT_MAX_LINES);
    expect(DEFAULT_MAX_BYTES).toBe(PI_DEFAULT_MAX_BYTES);
    for (const bytes of [
      0,
      1,
      1023,
      1024,
      1536,
      51200,
      1024 * 1024 - 1,
      1024 * 1024,
      5 * 1024 * 1024 + 7,
    ]) {
      expect(formatSize(bytes)).toBe(piFormatSize(bytes));
    }
  });

  it("truncates random content the same way (fuzz)", () => {
    const random = prng(52);
    for (let round = 0; round < 300; round++) {
      const lineCount = Math.floor(random() * 40);
      const content = Array.from(
        { length: lineCount },
        () => "é".repeat(Math.floor(random() * 6)) + "x".repeat(Math.floor(random() * 30)),
      ).join("\n");
      const options =
        random() < 0.2
          ? {}
          : {
              ...(random() < 0.8 ? { maxLines: 1 + Math.floor(random() * 20) } : {}),
              ...(random() < 0.8 ? { maxBytes: 1 + Math.floor(random() * 200) } : {}),
            };
      expect(truncateHead(content, options), JSON.stringify({ content, options })).toStrictEqual(
        piTruncateHead(content, options),
      );
    }
    const big = lines(3000, (i) => `row ${i} ${"z".repeat(i % 90)}`);
    expect(truncateHead(big)).toStrictEqual(piTruncateHead(big));
  });

  it("resolves paths the same way", () => {
    resetDirs();
    const inputs = [
      "a.txt",
      "./a.txt",
      "../a.txt",
      "/abs/a.txt",
      "~",
      "~/a.txt",
      "~/",
      "~user/a.txt",
      "@a.txt",
      "@~/a.txt",
      "@@a.txt",
      "@/abs/a.txt",
      "a\u00A0b.txt",
      "a\u2003b\u202Fc\u205Fd\u3000e.txt",
      "",
      ".",
      "dir/",
      "it's.txt",
      "Screen 1.00 PM.png",
      "caf\u00E9.txt",
    ];
    for (const input of inputs) {
      expect(expandPath(input), input).toBe(piExpandPath(input));
      expect(resolveToCwd(input, cwd), input).toBe(piResolveToCwd(input, cwd));
      expect(resolveReadPath(input, cwd), input).toBe(piResolveReadPath(input, cwd));
    }
    expect(expandPath("~/a.txt")).toBe(path.join(home, "a.txt"));
  });

  it("diffs random line sets like jsdiff and pi's generateDiffString (fuzz)", () => {
    // jsdiff is pi-coding-agent's dependency, not ours: resolve it from pi's package.
    const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    const piPackageJson = fs.realpathSync(
      path.join(repoRoot, "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
    );
    const jsdiff = createRequire(piPackageJson)("diff") as {
      diffLines: (oldStr: string, newStr: string) => LineChange[];
    };
    const plain = (changes: LineChange[]) =>
      changes.map((change) => ({
        count: change.count,
        added: change.added,
        removed: change.removed,
        value: change.value,
      }));

    const random = prng(8003);
    const vocabulary = ["a", "b", "c", "d", "e", "", "  ", "same", "same", "x y z"];
    const makeLines = (count: number) =>
      Array.from({ length: count }, () => vocabulary[Math.floor(random() * vocabulary.length)]);
    let withChanges = 0;
    for (let round = 0; round < 600; round++) {
      const before = makeLines(Math.floor(random() * 40));
      let after: string[];
      if (random() < 0.3) {
        after = makeLines(Math.floor(random() * 40));
      } else {
        // Mutate a copy: deletions, insertions and replacements.
        after = [...before];
        const mutations = Math.floor(random() * 6);
        for (let m = 0; m < mutations; m++) {
          const at = Math.floor(random() * (after.length + 1));
          const kind = random();
          if (kind < 0.34) {
            after.splice(at, Math.floor(random() * 3));
          } else if (kind < 0.67) {
            after.splice(at, 0, ...makeLines(1 + Math.floor(random() * 3)));
          } else {
            after.splice(at, 1, ...makeLines(1));
          }
        }
      }
      const eol = random() < 0.15 ? "\r\n" : "\n";
      const oldText = before.join(eol) + (random() < 0.5 ? eol : "");
      const newText = after.join(eol) + (random() < 0.5 ? eol : "");
      const label = JSON.stringify({ oldText, newText });
      const ours = diffLines(oldText, newText);
      expect(ours, label).toStrictEqual(plain(jsdiff.diffLines(oldText, newText)));
      for (const contextLines of [undefined, 0, 1, 4]) {
        expect(generateDiffString(oldText, newText, contextLines), label).toStrictEqual(
          piGenerateDiffString(oldText, newText, contextLines),
        );
      }
      if (ours.some((change) => change.added || change.removed)) {
        withChanges += 1;
      }
    }
    expect(withChanges).toBeGreaterThan(300);
    expect(diffLines("", "")).toStrictEqual(plain(jsdiff.diffLines("", "")));
    expect(diffLines("a", "")).toStrictEqual(plain(jsdiff.diffLines("a", "")));
    expect(diffLines("", "a\n")).toStrictEqual(plain(jsdiff.diffLines("", "a\n")));
  });

  it("applies edits to normalized content like pi (direct call)", () => {
    const content = "one\ntwo  \nthree\nfour\n";
    const edits = [
      { oldText: "two\nthree", newText: "2\n3" },
      { oldText: "four", newText: "4" },
    ];
    expect(applyEditsToNormalizedContent(content, edits, "f.txt")).toStrictEqual(
      piApplyEditsToNormalizedContent(content, edits, "f.txt"),
    );
  });
});
