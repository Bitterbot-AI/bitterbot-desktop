import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => tmpDir,
}));

const { workspaceHandlers } = await import("./workspace.js");

type TreeNode = { name: string; type: string; size?: number; children?: TreeNode[] };

async function runTree(params: Record<string, unknown> = {}): Promise<TreeNode[]> {
  let tree: TreeNode[] = [];
  await workspaceHandlers["workspace.tree"]({
    params,
    respond: (_ok: boolean, payload: { tree?: TreeNode[] }) => {
      tree = payload?.tree ?? [];
    },
  } as never);
  return tree;
}

function find(nodes: TreeNode[], name: string): TreeNode | undefined {
  return nodes.find((n) => n.name === name);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tree-test-"));
  await fs.writeFile(path.join(tmpDir, "a.txt"), "hello");
  await fs.mkdir(path.join(tmpDir, "sub"));
  await fs.writeFile(path.join(tmpDir, "sub", "b.txt"), "world!!");
  // An ignored directory should appear but not be recursed into.
  await fs.mkdir(path.join(tmpDir, "node_modules"));
  await fs.writeFile(path.join(tmpDir, "node_modules", "junk.js"), "x");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("workspace.tree", () => {
  it("omits file sizes by default (avoids per-entry fs.stat)", async () => {
    const tree = await runTree();
    const file = find(tree, "a.txt");
    expect(file?.type).toBe("file");
    expect(file?.size).toBeUndefined();
  });

  it("includes file sizes when includeSizes is set", async () => {
    const tree = await runTree({ includeSizes: true });
    expect(find(tree, "a.txt")?.size).toBe(5);
  });

  it("recurses into normal directories", async () => {
    const tree = await runTree({ includeSizes: true });
    const sub = find(tree, "sub");
    expect(sub?.type).toBe("directory");
    expect(find(sub?.children ?? [], "b.txt")?.size).toBe(7);
  });

  it("lists ignored directories but does not recurse into them", async () => {
    const tree = await runTree();
    const nm = find(tree, "node_modules");
    expect(nm?.type).toBe("directory");
    expect(nm?.children).toEqual([]);
  });
});
