import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_PARAM_GROUPS, wrapToolParamNormalization } from "./agent-tools.read.js";
import { createEditTool } from "./runtime/tools/coding/edit.js";

/**
 * A direct `execute` call (use_tool, plugins, tests) bypasses the agent loop
 * and so bypasses `prepareArguments`. The wrapper must apply the same
 * conversion itself, or the legacy edit forms fail its required-parameter
 * check with "Missing required parameter: edits" (Wave 3 regression).
 */
describe("wrapToolParamNormalization: direct execute accepts every edit argument form", () => {
  let dir = "";
  const file = () => path.join(dir, "a.txt");
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-edit-"));
    await fs.writeFile(file(), "hello world\n");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const wrapped = () =>
    wrapToolParamNormalization(createEditTool(dir) as never, CLAUDE_PARAM_GROUPS.edit);

  it.each([
    ["edits[]", () => ({ path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] })],
    ["legacy oldText/newText", () => ({ path: "a.txt", oldText: "hello", newText: "bye" })],
    [
      "Claude Code old_string/new_string + file_path",
      () => ({ file_path: "a.txt", old_string: "hello", new_string: "bye" }),
    ],
    [
      "edits[] sent as a JSON string",
      () => ({ path: "a.txt", edits: JSON.stringify([{ oldText: "hello", newText: "bye" }]) }),
    ],
  ])("%s", async (_label, args) => {
    const input = args();
    const before = JSON.stringify(input);
    await wrapped().execute("t", input);
    expect(await fs.readFile(file(), "utf8")).toBe("bye world\n");
    // The caller's object is left alone (prepare works on a copy).
    expect(JSON.stringify(input)).toBe(before);
  });

  it("prepareArguments followed by execute (the agent-loop order) converts only once", async () => {
    const tool = wrapped();
    const prepared = tool.prepareArguments!({ path: "a.txt", oldText: "hello", newText: "bye" });
    expect(prepared).toEqual({ path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] });
    await tool.execute("t", prepared);
    expect(await fs.readFile(file(), "utf8")).toBe("bye world\n");
  });

  it("still reports a missing replacement clearly", async () => {
    await expect(wrapped().execute("t", { path: "a.txt" })).rejects.toThrow(
      /Missing required parameter: edits \(or oldText\/newText\)/,
    );
  });
});
