/**
 * PLAN-52 Phase 5: tests of the read / write / edit file tools that do not
 * need pi-coding-agent. `coding-tools.differential.test.ts` compares the same
 * code with pi's and is deleted when that dependency goes; these stay.
 *
 * The snapshots are the goldens of what is sent to the model: a changed
 * character in a name, description or schema changes the prompt cache prefix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateToolArguments } from "@mariozechner/pi-ai";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../../agent-tools.types.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";
import { formatDimensionNote, resizeImage } from "./image-resize.js";
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
  truncateHead,
  withFileMutationQueue,
  type WriteOperations,
} from "./index.js";
import { diffLines } from "./line-diff.js";
import { detectSupportedImageMimeTypeFromFile } from "./mime.js";
import { expandPath, resolveReadPath, resolveToCwd } from "./path-utils.js";

let root = "";
let cwd = "";
let home = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-coding-tools-"));
  cwd = path.join(root, "ws");
  home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function file(rel: string, content: string | Buffer): string {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function readBack(rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), "utf-8");
}

function lines(count: number, make: (i: number) => string = (i) => `line ${i}`): string {
  return Array.from({ length: count }, (_, i) => make(i + 1)).join("\n");
}

type ToolResult = { content: Array<Record<string, string>>; details: unknown };

async function run(tool: AnyAgentTool, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
  return (await tool.execute("call_1", args, signal)) as unknown as ToolResult;
}

const read = (args: unknown) => run(createReadTool(cwd), args);
const write = (args: unknown) => run(createWriteTool(cwd), args);
const edit = (args: unknown) => run(createEditTool(cwd), args);

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } });

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  const tools = (): AnyAgentTool[] => [
    createReadTool("/workspace"),
    createEditTool("/workspace"),
    createWriteTool("/workspace"),
  ];

  it("match the goldens sent to the model", () => {
    for (const tool of tools()) {
      expect({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as unknown,
      }).toMatchSnapshot(tool.name);
      // Snapshots sort object keys; the serialized string pins the key order too.
      expect(JSON.stringify(tool.parameters)).toMatchSnapshot(`${tool.name} schema bytes`);
    }
  });

  it("have the AgentTool shape the gateway wrappers expect", () => {
    for (const tool of tools()) {
      expect(Object.keys(tool)).toStrictEqual([
        "name",
        "label",
        "description",
        "parameters",
        "prepareArguments",
        "executionMode",
        "execute",
      ]);
      expect(tool.executionMode).toBeUndefined();
      // No typebox symbols: pi-ai skips its JSON coercion when it sees one.
      expect(Object.getOwnPropertySymbols(tool.parameters as object)).toStrictEqual([]);
      expect(JSON.parse(JSON.stringify(tool.parameters))).toStrictEqual(tool.parameters);
    }
    expect(tools().map((tool) => tool.name)).toStrictEqual([...CODING_FILE_TOOL_NAMES]);
    expect(createReadTool("/a").prepareArguments).toBeUndefined();
    expect(createWriteTool("/a").prepareArguments).toBeUndefined();
    expect(typeof createEditTool("/a").prepareArguments).toBe("function");
  });

  it("validate and coerce through pi-ai like any other gateway tool", () => {
    const validate = (tool: AnyAgentTool, args: Record<string, unknown>) =>
      validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters as never },
        { type: "toolCall", id: "call_1", name: tool.name, arguments: args },
      ) as unknown;
    const readTool = createReadTool("/a");
    expect(validate(readTool, { path: "a.txt", offset: "3", limit: "5" })).toStrictEqual({
      path: "a.txt",
      offset: 3,
      limit: 5,
    });
    expect(() => validate(readTool, {})).toThrow(/path/);
    const editTool = createEditTool("/a");
    expect(() =>
      validate(editTool, { path: "a.txt", edits: [{ oldText: "a", newText: "b", extra: 1 }] }),
    ).toThrow(/Validation failed/);
    expect(() =>
      validate(editTool, { path: "a.txt", edits: [{ oldText: "a", newText: "b" }], extra: 1 }),
    ).toThrow(/Validation failed/);
    expect(() => validate(createWriteTool("/a"), { path: "a.txt" })).toThrow(/content/);
  });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("read", () => {
  it("returns a small file as it is, with no details", async () => {
    file("note.txt", "hello\nworld\n");
    expect(await read({ path: "note.txt" })).toStrictEqual({
      content: [{ type: "text", text: "hello\nworld\n" }],
      details: undefined,
    });
  });

  it("stops at 2000 lines and says how to continue", async () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    file("big.txt", lines(2500));
    const result = await read({ path: "big.txt" });
    const text = result.content[0].text;
    expect(text.split("\n").slice(0, 2000).join("\n")).toBe(lines(2000));
    expect(text.endsWith("\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]")).toBe(
      true,
    );
    expect(result.details).toMatchObject({
      truncation: {
        truncated: true,
        truncatedBy: "lines",
        totalLines: 2500,
        outputLines: 2000,
        maxLines: 2000,
        maxBytes: 51200,
        firstLineExceedsLimit: false,
        lastLinePartial: false,
      },
    });

    file("exact.txt", lines(2000));
    expect((await read({ path: "exact.txt" })).details).toBeUndefined();
  });

  it("stops at 50KB on a line boundary and says how to continue", async () => {
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
    // 100 bytes per line with the newline: 512 lines are exactly 51200 bytes.
    file(
      "wide.txt",
      lines(1000, (i) => String(i).padStart(99, "0")),
    );
    const result = await read({ path: "wide.txt" });
    expect(
      result.content[0].text.endsWith(
        "\n\n[Showing lines 1-512 of 1000 (50.0KB limit). Use offset=513 to continue.]",
      ),
    ).toBe(true);
    expect(result.details).toMatchObject({
      truncation: { truncatedBy: "bytes", outputLines: 512, outputBytes: 51199 },
    });
  });

  it("points at a shell fallback when one line is larger than the limit", async () => {
    file("oneline.txt", `${"y".repeat(60 * 1024)}\nsecond\n`);
    const result = await read({ path: "oneline.txt" });
    expect(result.content[0].text).toBe(
      "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' oneline.txt | head -c 51200]",
    );
    expect(result.details).toMatchObject({ truncation: { firstLineExceedsLimit: true } });
  });

  it("honours offset and limit, 1-indexed", async () => {
    file("ten.txt", lines(10));
    expect((await read({ path: "ten.txt", offset: 4, limit: 2 })).content[0].text).toBe(
      "line 4\nline 5\n\n[5 more lines in file. Use offset=6 to continue.]",
    );
    expect((await read({ path: "ten.txt", offset: 9 })).content[0].text).toBe("line 9\nline 10");
    expect((await read({ path: "ten.txt", limit: 10 })).content[0].text).toBe(lines(10));
    expect((await read({ path: "ten.txt", offset: 0, limit: 1 })).content[0].text).toBe(
      "line 1\n\n[9 more lines in file. Use offset=2 to continue.]",
    );
    await expect(read({ path: "ten.txt", offset: 11 })).rejects.toThrow(
      "Offset 11 is beyond end of file (10 lines total)",
    );

    file("big.txt", lines(5000));
    const result = await read({ path: "big.txt", offset: 1500 });
    expect(
      result.content[0].text.endsWith(
        "[Showing lines 1500-3499 of 5000. Use offset=3500 to continue.]",
      ),
    ).toBe(true);
  });

  it("rejects for a missing file, a directory and missing arguments", async () => {
    await expect(read({ path: "missing.txt" })).rejects.toThrow(/ENOENT/);
    fs.mkdirSync(path.join(cwd, "folder"));
    await expect(read({ path: "folder" })).rejects.toThrow(/EISDIR/);
    // A rejection, never a synchronous throw.
    const pending = createReadTool(cwd).execute("call_1", undefined as never);
    await expect(pending).rejects.toThrow(TypeError);
  });

  it("returns a supported image as an attachment, detected by content", async () => {
    const png = await solid(64, 48).png().toBuffer();
    file("picture.dat", png);
    expect(await read({ path: "picture.dat" })).toStrictEqual({
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
      details: undefined,
    });
    file("fake.png", "just text\n");
    expect((await read({ path: "fake.png" })).content).toStrictEqual([
      { type: "text", text: "just text\n" },
    ]);
  });

  it("downscales an image larger than 2000px and explains the scale", async () => {
    file("wide.png", await solid(2400, 1300).png().toBuffer());
    const result = await read({ path: "wide.png" });
    expect(result.content[0].text).toBe(
      "Read image file [image/png]\n[Image: original 2400x1300, displayed at 2000x1083. Multiply coordinates by 1.20 to map to original image.]",
    );
    expect(result.content[1].mimeType).toBe("image/png");
    const meta = await sharp(Buffer.from(result.content[1].data, "base64")).metadata();
    expect({ width: meta.width, height: meta.height }).toStrictEqual({ width: 2000, height: 1083 });

    const untouched = await run(createReadTool(cwd, { autoResizeImages: false }), {
      path: "wide.png",
    });
    expect(untouched.content[0].text).toBe("Read image file [image/png]");
    expect(untouched.content[1].data).toBe(readBackBase64("wide.png"));
  });

  it("omits an image it cannot decode instead of passing it on", async () => {
    const good = await solid(300, 200).png().toBuffer();
    file("broken.png", good.subarray(0, 60));
    expect((await read({ path: "broken.png" })).content).toStrictEqual([
      {
        type: "text",
        text: "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
      },
    ]);
  });

  it("resolves home, @ and absolute paths", async () => {
    fs.writeFileSync(path.join(home, "in-home.txt"), "home\n");
    expect((await read({ path: "~/in-home.txt" })).content[0].text).toBe("home\n");
    file("mention.txt", "at\n");
    expect((await read({ path: "@mention.txt" })).content[0].text).toBe("at\n");
    expect((await read({ path: path.join(cwd, "mention.txt") })).content[0].text).toBe("at\n");
  });

  it("rejects when aborted", async () => {
    file("a.txt", "x\n");
    const controller = new AbortController();
    controller.abort();
    await expect(run(createReadTool(cwd), { path: "a.txt" }, controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });

  it("reads through custom operations", async () => {
    const calls: string[] = [];
    const operations: ReadOperations = {
      access: async (absolutePath) => {
        calls.push(`access ${absolutePath}`);
      },
      readFile: async (absolutePath) => {
        calls.push(`readFile ${absolutePath}`);
        return Buffer.from("from the sandbox\n");
      },
    };
    const result = await run(createReadTool(cwd, { operations }), { path: "inside/v.txt" });
    expect(result.content[0].text).toBe("from the sandbox\n");
    const virtual = path.join(cwd, "inside", "v.txt");
    expect(calls).toStrictEqual([`access ${virtual}`, `readFile ${virtual}`]);
  });

  function readBackBase64(rel: string): string {
    return fs.readFileSync(path.join(cwd, rel)).toString("base64");
  }
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("write", () => {
  it("creates a file with its parent directories", async () => {
    expect(await write({ path: "a/b/new.txt", content: "hello\n" })).toStrictEqual({
      content: [{ type: "text", text: "Successfully wrote 6 bytes to a/b/new.txt" }],
      details: undefined,
    });
    expect(readBack("a/b/new.txt")).toBe("hello\n");
  });

  it("overwrites an existing file", async () => {
    file("old.txt", "a much longer previous content\n");
    await write({ path: "old.txt", content: "short" });
    expect(readBack("old.txt")).toBe("short");
  });

  it("resolves home and absolute paths", async () => {
    await write({ path: "~/notes/t.txt", content: "tilde" });
    expect(fs.readFileSync(path.join(home, "notes", "t.txt"), "utf-8")).toBe("tilde");
    const absolute = path.join(root, "elsewhere", "abs.txt");
    const result = await write({ path: absolute, content: "abs" });
    expect(result.content[0].text).toBe(`Successfully wrote 3 bytes to ${absolute}`);
    expect(fs.readFileSync(absolute, "utf-8")).toBe("abs");
  });

  it("rejects for a directory target, bad arguments and an aborted signal", async () => {
    fs.mkdirSync(path.join(cwd, "folder"));
    await expect(write({ path: "folder", content: "x" })).rejects.toThrow(/EISDIR/);
    await expect(createWriteTool(cwd).execute("call_1", undefined as never)).rejects.toThrow(
      TypeError,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(createWriteTool(cwd), { path: "a.txt", content: "x" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
    expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(false);
  });

  it("writes through custom operations", async () => {
    const calls: unknown[] = [];
    const operations: WriteOperations = {
      mkdir: async (dir) => {
        calls.push(["mkdir", dir]);
      },
      writeFile: async (absolutePath, content) => {
        calls.push(["writeFile", absolutePath, content]);
      },
    };
    await run(createWriteTool(cwd, { operations }), { path: "v/x.txt", content: "payload" });
    expect(calls).toStrictEqual([
      ["mkdir", path.join(cwd, "v")],
      ["writeFile", path.join(cwd, "v", "x.txt"), "payload"],
    ]);
    expect(fs.existsSync(path.join(cwd, "v"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("edit", () => {
  it("replaces one block and reports a numbered diff", async () => {
    file("note.txt", "alpha beta gamma\nsecond line\n");
    expect(
      await edit({ path: "note.txt", edits: [{ oldText: "beta", newText: "BETA" }] }),
    ).toStrictEqual({
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in note.txt." }],
      details: {
        diff: "-1 alpha beta gamma\n+1 alpha BETA gamma\n 2 second line",
        firstChangedLine: 1,
      },
    });
    expect(readBack("note.txt")).toBe("alpha BETA gamma\nsecond line\n");
  });

  it("applies several edits against the original content and elides far context", async () => {
    file("multi.txt", `${lines(30)}\n`);
    const result = await edit({
      path: "multi.txt",
      edits: [
        { oldText: "line 25\n", newText: "" },
        { oldText: "line 3\n", newText: "line three\nline three and a half\n" },
      ],
    });
    expect(result.content[0].text).toBe("Successfully replaced 2 block(s) in multi.txt.");
    expect(result.details).toStrictEqual({
      diff: [
        "  1 line 1",
        "  2 line 2",
        "- 3 line 3",
        "+ 3 line three",
        "+ 4 line three and a half",
        "  4 line 4",
        "  5 line 5",
        "  6 line 6",
        "  7 line 7",
        "    ...",
        " 21 line 21",
        " 22 line 22",
        " 23 line 23",
        " 24 line 24",
        "-25 line 25",
        " 26 line 26",
        " 27 line 27",
        " 28 line 28",
        " 29 line 29",
        "    ...",
      ].join("\n"),
      firstChangedLine: 3,
    });
    const expected = lines(30)
      .replace("line 25\n", "")
      .replace("line 3\n", "line three\nline three and a half\n");
    expect(readBack("multi.txt")).toBe(`${expected}\n`);
  });

  it("explains every way an edit cannot be applied, and leaves the file alone", async () => {
    const original = "one two one\nthree\n";
    file("f.txt", original);
    const failing: Array<[unknown, string]> = [
      [
        { path: "f.txt", edits: [{ oldText: "four", newText: "x" }] },
        "Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines.",
      ],
      [
        {
          path: "f.txt",
          edits: [
            { oldText: "three", newText: "3" },
            { oldText: "four", newText: "x" },
          ],
        },
        "Could not find edits[1] in f.txt. The oldText must match exactly including all whitespace and newlines.",
      ],
      [
        { path: "f.txt", edits: [{ oldText: "one", newText: "1" }] },
        "Found 2 occurrences of the text in f.txt. The text must be unique. Please provide more context to make it unique.",
      ],
      [
        {
          path: "f.txt",
          edits: [
            { oldText: "three", newText: "3" },
            { oldText: "one", newText: "1" },
          ],
        },
        "Found 2 occurrences of edits[1] in f.txt. Each oldText must be unique. Please provide more context to make it unique.",
      ],
      [
        {
          path: "f.txt",
          edits: [
            { oldText: "two one", newText: "x" },
            { oldText: "one two", newText: "y" },
          ],
        },
        "edits[1] and edits[0] overlap in f.txt. Merge them into one edit or target disjoint regions.",
      ],
      [
        { path: "f.txt", edits: [{ oldText: "", newText: "x" }] },
        "oldText must not be empty in f.txt.",
      ],
      [
        {
          path: "f.txt",
          edits: [
            { oldText: "three", newText: "3" },
            { oldText: "", newText: "x" },
          ],
        },
        "edits[1].oldText must not be empty in f.txt.",
      ],
      [
        { path: "f.txt", edits: [{ oldText: "three", newText: "three" }] },
        "No changes made to f.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
      ],
      [
        {
          path: "f.txt",
          edits: [
            { oldText: "three", newText: "three" },
            { oldText: "two", newText: "two" },
          ],
        },
        "No changes made to f.txt. The replacements produced identical content.",
      ],
      [
        { path: "f.txt", edits: [] },
        "Edit tool input is invalid. edits must contain at least one replacement.",
      ],
      [
        { path: "f.txt", oldText: "three", newText: "3" },
        "Edit tool input is invalid. edits must contain at least one replacement.",
      ],
      [
        { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
        "Could not edit file: missing.txt. Error code: ENOENT.",
      ],
    ];
    for (const [args, message] of failing) {
      let caught: unknown;
      try {
        await edit(args);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message, JSON.stringify(args)).toBe(message);
      expect(readBack("f.txt")).toBe(original);
    }
  });

  it("keeps CRLF line endings and a BOM", async () => {
    file("crlf.txt", "\uFEFFone\r\ntwo\r\nthree\r\n");
    await edit({ path: "crlf.txt", edits: [{ oldText: "two\nthree", newText: "2\n3\nextra" }] });
    expect(readBack("crlf.txt")).toBe("\uFEFFone\r\n2\r\n3\r\nextra\r\n");
  });

  it("matches despite trailing whitespace and typographic characters", async () => {
    file("ws.txt", "keep   \nfunction a() {   \n  return 1;\t\n}\n");
    await edit({
      path: "ws.txt",
      edits: [
        { oldText: "function a() {\n  return 1;\n}", newText: "function a() {\n  return 2;\n}" },
      ],
    });
    // A fuzzy match rewrites the file in normalized form (trailing whitespace gone everywhere).
    expect(readBack("ws.txt")).toBe("keep\nfunction a() {\n  return 2;\n}\n");

    file("typo.txt", "She said \u201Chello\u201D \u2014 it\u2019s fine\n");
    await edit({
      path: "typo.txt",
      edits: [{ oldText: 'said "hello" - it\'s', newText: "wrote: it is" }],
    });
    expect(readBack("typo.txt")).toBe("She wrote: it is fine\n");
  });

  it("folds legacy arguments into edits[] before validation", () => {
    const prepare = createEditTool(cwd).prepareArguments as (args: unknown) => unknown;
    expect(prepare({ path: "a.txt", oldText: "a", newText: "b" })).toStrictEqual({
      path: "a.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(
      prepare({
        path: "a.txt",
        edits: [{ oldText: "x", newText: "y" }],
        oldText: "a",
        newText: "b",
      }),
    ).toStrictEqual({
      path: "a.txt",
      edits: [
        { oldText: "x", newText: "y" },
        { oldText: "a", newText: "b" },
      ],
    });
    // Some models send edits as a JSON string.
    expect(prepare({ path: "a.txt", edits: '[{"oldText":"x","newText":"y"}]' })).toStrictEqual({
      path: "a.txt",
      edits: [{ oldText: "x", newText: "y" }],
    });
    expect(prepare({ path: "a.txt", edits: "not json" })).toStrictEqual({
      path: "a.txt",
      edits: "not json",
    });
    // Anything else is passed through for the validator to reject.
    const untouched = { path: "a.txt", oldText: "a" };
    expect(prepare(untouched)).toBe(untouched);
    expect(prepare(null)).toBeNull();
    expect(prepare("text")).toBe("text");
  });

  it("runs the legacy shape end to end", async () => {
    file("note.txt", "alpha beta gamma\n");
    const tool = createEditTool(cwd);
    const prepared = tool.prepareArguments?.({
      path: "note.txt",
      oldText: "gamma",
      newText: "GAMMA",
    }) as unknown;
    await run(tool, prepared);
    expect(readBack("note.txt")).toBe("alpha beta GAMMA\n");
  });

  it("rejects when aborted and does not write", async () => {
    file("a.txt", "alpha\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(
        createEditTool(cwd),
        { path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }] },
        controller.signal,
      ),
    ).rejects.toThrow("Operation aborted");
    expect(readBack("a.txt")).toBe("alpha\n");
  });

  it("edits through custom operations", async () => {
    const calls: unknown[] = [];
    const operations: EditOperations = {
      access: async (absolutePath) => {
        calls.push(["access", absolutePath]);
      },
      readFile: async (absolutePath) => {
        calls.push(["readFile", absolutePath]);
        return Buffer.from("one\ntwo\n");
      },
      writeFile: async (absolutePath, content) => {
        calls.push(["writeFile", absolutePath, content]);
      },
    };
    await run(createEditTool(cwd, { operations }), {
      path: "v.txt",
      edits: [{ oldText: "two", newText: "2" }],
    });
    const virtual = path.join(cwd, "v.txt");
    expect(calls).toStrictEqual([
      ["access", virtual],
      ["readFile", virtual],
      ["writeFile", virtual, "one\n2\n"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Serialization per path
// ---------------------------------------------------------------------------

describe("file mutation queue", () => {
  it("does not lose concurrent edits to one file", async () => {
    const count = 12;
    file(
      "shared.txt",
      lines(count, (i) => `slot-${i};`),
    );
    const tool = createEditTool(cwd);
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        run(tool, {
          path: "shared.txt",
          edits: [{ oldText: `slot-${i + 1};`, newText: `done-${i + 1};` }],
        }),
      ),
    );
    expect(readBack("shared.txt")).toBe(lines(count, (i) => `done-${i};`));
  });

  it("runs writes and edits to one file in call order, across spellings of the path", async () => {
    file("shared.txt", "start\n");
    await Promise.all([
      write({ path: "shared.txt", content: "one\n" }),
      edit({ path: "./shared.txt", edits: [{ oldText: "one", newText: "two" }] }),
      edit({ path: path.join(cwd, "shared.txt"), edits: [{ oldText: "two", newText: "three" }] }),
    ]);
    expect(readBack("shared.txt")).toBe("three\n");
  });

  it("serializes one path, runs different paths in parallel, and survives a failure", async () => {
    const events: string[] = [];
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const job =
      (name: string, ms: number, fail = false) =>
      async () => {
        events.push(`start ${name}`);
        await delay(ms);
        events.push(`end ${name}`);
        if (fail) {
          throw new Error(`${name} failed`);
        }
        return name;
      };
    const same = path.join(cwd, "same.txt");
    const settled = await Promise.allSettled([
      withFileMutationQueue(same, job("a", 30, true)),
      withFileMutationQueue(same, job("b", 5)),
      withFileMutationQueue(path.join(cwd, "other.txt"), job("c", 10)),
    ]);
    expect(settled.map((entry) => entry.status)).toStrictEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(events).toStrictEqual(["start a", "start c", "end c", "end a", "start b", "end b"]);
  });

  it("queues a symlink together with its target", async () => {
    const target = file("target.txt", "x");
    const link = path.join(cwd, "link.txt");
    fs.symlinkSync(target, link);
    const events: string[] = [];
    await Promise.all([
      withFileMutationQueue(target, async () => {
        events.push("target start");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        events.push("target end");
      }),
      withFileMutationQueue(link, async () => {
        events.push("link");
      }),
    ]);
    expect(events).toStrictEqual(["target start", "target end", "link"]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("truncateHead", () => {
  it("keeps content within both limits untouched", () => {
    expect(truncateHead("a\nb\nc")).toStrictEqual({
      content: "a\nb\nc",
      truncated: false,
      truncatedBy: null,
      totalLines: 3,
      totalBytes: 5,
      outputLines: 3,
      outputBytes: 5,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2000,
      maxBytes: 51200,
    });
  });

  it("cuts on whichever limit is hit first and never returns a partial line", () => {
    const byLines = truncateHead("a\nb\nc\nd", { maxLines: 2 });
    expect(byLines).toMatchObject({ content: "a\nb", truncatedBy: "lines", outputLines: 2 });
    const byBytes = truncateHead("aaaa\nbbbb\ncccc", { maxBytes: 10 });
    expect(byBytes).toMatchObject({ content: "aaaa\nbbbb", truncatedBy: "bytes", outputBytes: 9 });
    const multiByte = truncateHead("éé\néé", { maxBytes: 5 });
    expect(multiByte).toMatchObject({ content: "éé", truncatedBy: "bytes", outputBytes: 4 });
    const firstLine = truncateHead("abcdef\nx", { maxBytes: 3 });
    expect(firstLine).toMatchObject({
      content: "",
      truncatedBy: "bytes",
      firstLineExceedsLimit: true,
      outputLines: 0,
    });
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1536)).toBe("1.5KB");
    expect(formatSize(DEFAULT_MAX_BYTES)).toBe("50.0KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});

describe("path resolution", () => {
  it("expands home, drops a leading @ and normalizes Unicode spaces", () => {
    expect(expandPath("~")).toBe(home);
    // The rest of the path is appended as written, so on Windows the result
    // mixes separators (which Windows accepts). Same as path.join on POSIX.
    expect(expandPath("~/a.txt")).toBe(`${home}/a.txt`);
    expect(expandPath("~user/a.txt")).toBe("~user/a.txt");
    expect(expandPath("@a.txt")).toBe("a.txt");
    expect(expandPath("a\u00A0b\u202Fc.txt")).toBe("a b c.txt");
    expect(resolveToCwd("a.txt", cwd)).toBe(path.join(cwd, "a.txt"));
    expect(resolveToCwd("/abs/a.txt", cwd)).toBe("/abs/a.txt");
    expect(resolveToCwd("../a.txt", cwd)).toBe(path.join(root, "a.txt"));
  });

  it("tries the macOS filename variants for reads only when the plain path is missing", () => {
    const narrow = file("Shot at 1.00\u202FPM.txt", "x");
    expect(resolveReadPath("Shot at 1.00 PM.txt", cwd)).toBe(narrow);
    const nfd = file("cafe\u0301.txt", "x");
    // APFS and HFS+ treat the NFC and NFD spellings as one file. There the
    // plain path exists, so it is returned as it is and no variant is tried.
    const nfcPath = path.join(cwd, "caf\u00E9.txt");
    const sameFileOnThisFilesystem = fs.existsSync(nfcPath);
    if (process.platform === "linux") {
      expect(sameFileOnThisFilesystem).toBe(false);
    }
    expect(resolveReadPath("caf\u00E9.txt", cwd)).toBe(sameFileOnThisFilesystem ? nfcPath : nfd);
    const curly = file("d\u2019accord.txt", "x");
    expect(resolveReadPath("d'accord.txt", cwd)).toBe(curly);
    expect(resolveReadPath("nothing.txt", cwd)).toBe(path.join(cwd, "nothing.txt"));
    // Writes and edits never take a variant.
    expect(resolveToCwd("d'accord.txt", cwd)).toBe(path.join(cwd, "d'accord.txt"));
  });
});

describe("edit matching and diff helpers", () => {
  it("detects, normalizes and restores line endings", () => {
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("no newline")).toBe("\n");
    expect(normalizeToLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(restoreLineEndings("a\nb\n", "\n")).toBe("a\nb\n");
    expect(stripBom("\uFEFFx")).toStrictEqual({ bom: "\uFEFF", text: "x" });
    expect(stripBom("x")).toStrictEqual({ bom: "", text: "x" });
  });

  it("matches exactly first and falls back to normalized text", () => {
    expect(fuzzyFindText("a b c", "b")).toMatchObject({
      found: true,
      index: 2,
      usedFuzzyMatch: false,
    });
    expect(fuzzyFindText("it\u2019s  \nok", "it's\nok")).toMatchObject({
      found: true,
      index: 0,
      usedFuzzyMatch: true,
      contentForReplacement: "it's\nok",
    });
    expect(fuzzyFindText("abc", "x")).toMatchObject({ found: false, index: -1 });
    expect(normalizeForFuzzyMatch("\u201Cq\u201D \u2013 \uFB01 \u00A0x  ")).toBe('"q" - fi  x');
  });

  it("applies edits in one pass against the original content", () => {
    expect(
      applyEditsToNormalizedContent(
        "one\ntwo\nthree\n",
        [
          { oldText: "three", newText: "3" },
          { oldText: "one", newText: "three" },
        ],
        "f.txt",
      ),
    ).toStrictEqual({ baseContent: "one\ntwo\nthree\n", newContent: "three\ntwo\n3\n" });
  });

  it("computes line diffs", () => {
    expect(diffLines("a\nb\nc\n", "a\nx\nc\n")).toStrictEqual([
      { count: 1, added: false, removed: false, value: "a\n" },
      { count: 1, added: false, removed: true, value: "b\n" },
      { count: 1, added: true, removed: false, value: "x\n" },
      { count: 1, added: false, removed: false, value: "c\n" },
    ]);
    expect(diffLines("", "")).toStrictEqual([]);
    expect(diffLines("same\n", "same\n")).toStrictEqual([
      { count: 1, added: false, removed: false, value: "same\n" },
    ]);
    expect(diffLines("a\nb", "a\nb\n")).toStrictEqual([
      { count: 1, added: false, removed: false, value: "a\n" },
      { count: 1, added: false, removed: true, value: "b" },
      { count: 1, added: true, removed: false, value: "b\n" },
    ]);
    expect(diffLines("", "a\nb\n")).toStrictEqual([
      { count: 2, added: true, removed: false, value: "a\nb\n" },
    ]);
  });

  it("renders a numbered diff with limited context", () => {
    const before = `${lines(12)}\n`;
    const after = before.replace("line 6\n", "line six\n");
    expect(generateDiffString(before, after)).toStrictEqual({
      diff: [
        "    ...",
        "  2 line 2",
        "  3 line 3",
        "  4 line 4",
        "  5 line 5",
        "- 6 line 6",
        "+ 6 line six",
        "  7 line 7",
        "  8 line 8",
        "  9 line 9",
        " 10 line 10",
        "    ...",
      ].join("\n"),
      firstChangedLine: 6,
    });
    expect(generateDiffString("a\n", "a\n")).toStrictEqual({
      diff: "",
      firstChangedLine: undefined,
    });
    expect(generateDiffString(before, after, 1).diff).toBe(
      ["    ...", "  5 line 5", "- 6 line 6", "+ 6 line six", "  7 line 7", "    ..."].join("\n"),
    );
  });
});

describe("image helpers", () => {
  it("detects the four supported image types from content", async () => {
    expect(
      await detectSupportedImageMimeTypeFromFile(file("a.bin", await solid(8, 8).png().toBuffer())),
    ).toBe("image/png");
    expect(
      await detectSupportedImageMimeTypeFromFile(
        file("b.bin", await solid(8, 8).jpeg().toBuffer()),
      ),
    ).toBe("image/jpeg");
    expect(
      await detectSupportedImageMimeTypeFromFile(
        file("c.bin", await solid(8, 8).webp().toBuffer()),
      ),
    ).toBe("image/webp");
    expect(
      await detectSupportedImageMimeTypeFromFile(file("d.bin", await solid(8, 8).gif().toBuffer())),
    ).toBe("image/gif");
    // Recognized by file-type, but not a type the read tool attaches.
    expect(
      await detectSupportedImageMimeTypeFromFile(
        file("e.bin", await solid(8, 8).tiff().toBuffer()),
      ),
    ).toBeNull();
    expect(await detectSupportedImageMimeTypeFromFile(file("f.txt", "plain text"))).toBeNull();
    expect(await detectSupportedImageMimeTypeFromFile(file("empty.png", ""))).toBeNull();
  });

  it("returns an image within the limits unchanged", async () => {
    const data = (await solid(100, 50).png().toBuffer()).toString("base64");
    expect(await resizeImage({ type: "image", data, mimeType: "image/png" })).toStrictEqual({
      data,
      mimeType: "image/png",
      originalWidth: 100,
      originalHeight: 50,
      width: 100,
      height: 50,
      wasResized: false,
    });
  });

  it("falls back to JPEG and then to smaller sizes to get under the byte limit", async () => {
    // Noise does not compress: PNG stays large, JPEG gets under the limit sooner.
    const width = 200;
    const height = 100;
    const noise = Buffer.alloc(width * height * 3);
    let state = 12345;
    for (let i = 0; i < noise.length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      noise[i] = state >>> 24;
    }
    const png = await sharp(noise, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const image = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
    expect(Buffer.byteLength(image.data)).toBeGreaterThan(60_000);

    const asJpeg = await resizeImage(image, { maxBytes: 40_000 });
    expect(asJpeg).toMatchObject({
      mimeType: "image/jpeg",
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      wasResized: true,
    });
    expect(Buffer.byteLength(asJpeg?.data ?? "")).toBeLessThan(40_000);

    const smaller = await resizeImage(image, { maxBytes: 3_000 });
    expect(smaller?.wasResized).toBe(true);
    expect(smaller?.width).toBeLessThan(width);
    // Each step is 75% of the previous size, rounded down.
    expect([150, 112, 84, 63, 47, 35, 26, 19, 14, 10, 7, 5, 3, 2, 1]).toContain(smaller?.width);
    expect(Buffer.byteLength(smaller?.data ?? "")).toBeLessThan(3_000);

    // Nothing fits in 10 bytes, even at 1x1.
    expect(await resizeImage(image, { maxBytes: 10 })).toBeNull();
    // Not an image at all.
    expect(
      await resizeImage({
        type: "image",
        data: Buffer.from("not an image").toString("base64"),
        mimeType: "image/png",
      }),
    ).toBeNull();
  });

  it("resizes CMYK, grayscale, 16-bit and alpha sources into 8-bit images of the target size", async () => {
    const source = () =>
      sharp({
        create: { width: 300, height: 150, channels: 3, background: { r: 200, g: 40, b: 90 } },
      });
    const sources: Array<{ name: string; bytes: Buffer; mimeType: string; channels: number }> = [
      {
        name: "cmyk",
        bytes: await source().toColourspace("cmyk").jpeg().toBuffer(),
        mimeType: "image/jpeg",
        channels: 3,
      },
      {
        name: "grayscale",
        bytes: await source().toColourspace("b-w").png().toBuffer(),
        mimeType: "image/png",
        channels: 3,
      },
      {
        name: "16-bit",
        bytes: await source().toColourspace("rgb16").png().toBuffer(),
        mimeType: "image/png",
        channels: 3,
      },
      {
        name: "alpha",
        bytes: await source().ensureAlpha(0.5).png().toBuffer(),
        mimeType: "image/png",
        channels: 4,
      },
    ];
    for (const entry of sources) {
      const resized = await resizeImage(
        { type: "image", data: entry.bytes.toString("base64"), mimeType: entry.mimeType },
        { maxWidth: 100, maxHeight: 100 },
      );
      expect(resized, entry.name).toMatchObject({
        mimeType: "image/png",
        originalWidth: 300,
        originalHeight: 150,
        width: 100,
        height: 50,
        wasResized: true,
      });
      const meta = await sharp(Buffer.from(resized?.data ?? "", "base64")).metadata();
      expect(
        { width: meta.width, height: meta.height, depth: meta.depth, channels: meta.channels },
        entry.name,
      ).toStrictEqual({ width: 100, height: 50, depth: "uchar", channels: entry.channels });
    }
  });

  it("formats the dimension note only for resized images", () => {
    const base = { data: "", mimeType: "image/png", originalWidth: 3000, originalHeight: 1500 };
    expect(
      formatDimensionNote({ ...base, width: 3000, height: 1500, wasResized: false }),
    ).toBeUndefined();
    expect(formatDimensionNote({ ...base, width: 2000, height: 1000, wasResized: true })).toBe(
      "[Image: original 3000x1500, displayed at 2000x1000. Multiply coordinates by 1.50 to map to original image.]",
    );
  });
});
