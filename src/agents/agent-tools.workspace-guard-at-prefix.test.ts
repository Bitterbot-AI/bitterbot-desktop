/**
 * Adversarial review of the vendored file tools (PLAN-52 Phase 5).
 *
 * `tools.fs.workspaceOnly` wraps read/write/edit in `wrapToolWorkspaceRootGuard`,
 * which checks the path with `sandbox-paths.ts`. That resolver does not know
 * the leading "@" the file tools drop (`path-utils.ts` `normalizeAtPrefix`):
 * the guard sees "@/abs/path" as the relative path "<root>/@/abs/path" and
 * lets it through, then the tool strips the "@" and opens "/abs/path".
 *
 * The same hole existed with pi 0.73.1's tools (the last test shows it), so
 * this is not a regression of the port. It is listed because the path code is
 * now owned here and its header says the guard-relevant rules are unchanged.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool as createPiReadTool } from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_PARAM_GROUPS,
  createBitterbotReadTool,
  wrapToolParamNormalization,
  wrapToolWorkspaceRootGuard,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createEditTool, createReadTool, createWriteTool } from "./runtime/tools/coding/index.js";

let base = "";
let workspace = "";
let outside = "";

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-guard-review-"));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "outside-the-workspace\n");
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function guardedRead(): AnyAgentTool {
  return wrapToolWorkspaceRootGuard(
    createBitterbotReadTool(createReadTool(workspace) as unknown as AnyAgentTool),
    workspace,
  );
}

describe("workspace-only guard vs the '@' prefix the file tools strip", () => {
  it("sanity: the guard rejects the plain absolute path", async () => {
    await expect(
      guardedRead().execute("call-1", { path: path.join(outside, "secret.txt") }, undefined),
    ).rejects.toThrow(/escapes sandbox root/);
  });

  it("read: '@<absolute path outside the workspace>' is rejected", async () => {
    await expect(
      guardedRead().execute("call-1", { path: `@${path.join(outside, "secret.txt")}` }, undefined),
    ).rejects.toThrow(/escapes sandbox root/);
  });

  it("read: '@../outside/secret.txt' is rejected", async () => {
    await expect(
      guardedRead().execute("call-1", { path: "@../outside/secret.txt" }, undefined),
    ).rejects.toThrow(/escapes sandbox root/);
  });

  it("write: '@<absolute path outside the workspace>' is rejected and nothing is written", async () => {
    const target = path.join(outside, "written.txt");
    const tool = wrapToolWorkspaceRootGuard(
      wrapToolParamNormalization(
        createWriteTool(workspace) as unknown as AnyAgentTool,
        CLAUDE_PARAM_GROUPS.write,
      ),
      workspace,
    );
    const outcome = await tool
      .execute("call-1", { path: `@${target}`, content: "escaped" }, undefined)
      .then(
        () => "resolved",
        () => "rejected",
      );
    const written = await fs.readFile(target, "utf8").catch(() => null);
    await fs.rm(target, { force: true });
    expect({ outcome, written }).toEqual({ outcome: "rejected", written: null });
  });

  it("edit: '@<absolute path outside the workspace>' is rejected and the file is unchanged", async () => {
    const target = path.join(outside, "edit-me.txt");
    await fs.writeFile(target, "before\n");
    const tool = wrapToolWorkspaceRootGuard(
      wrapToolParamNormalization(
        createEditTool(workspace) as unknown as AnyAgentTool,
        CLAUDE_PARAM_GROUPS.edit,
      ),
      workspace,
    );
    const outcome = await tool
      .execute(
        "call-1",
        { path: `@${target}`, edits: [{ oldText: "before", newText: "after" }] },
        undefined,
      )
      .then(
        () => "resolved",
        () => "rejected",
      );
    expect({ outcome, content: await fs.readFile(target, "utf8") }).toEqual({
      outcome: "rejected",
      content: "before\n",
    });
  });

  it("pi 0.73.1's read tool behind the guard is contained too (it had the same hole)", async () => {
    const tool = wrapToolWorkspaceRootGuard(
      createBitterbotReadTool(createPiReadTool(workspace) as unknown as AnyAgentTool),
      workspace,
    );
    await expect(
      tool.execute("call-1", { path: `@${path.join(outside, "secret.txt")}` }, undefined),
    ).rejects.toThrow();
  });
});
