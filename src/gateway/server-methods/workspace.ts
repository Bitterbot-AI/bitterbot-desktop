import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";

/** Resolve workspace root and validate that a requested path stays inside it. */
function resolveAndGuard(workspaceRoot: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceRoot, relativePath);
  // Must be inside workspace root (or be the root itself)
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    return null;
  }
  return resolved;
}

/** Max depth for tree traversal to prevent runaway recursion. */
const MAX_TREE_DEPTH = 12;
/** Max total entries to prevent huge payloads. */
const MAX_TREE_ENTRIES = 5000;

export type FileTreeNode = {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "directory";
  size?: number;
  children?: FileTreeNode[];
};

/** Directories to skip in tree listing. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".bitterbot",
  ".venv",
  "venv",
  ".next",
  "dist",
  "build",
  ".cache",
]);

type TreeCounter = { value: number };

async function buildTree(
  absPath: string,
  relativePath: string,
  depth: number,
  counter: TreeCounter,
): Promise<FileTreeNode[]> {
  if (depth > MAX_TREE_DEPTH || counter.value > MAX_TREE_ENTRIES) return [];

  let entries;
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    if (counter.value > MAX_TREE_ENTRIES) break;
    counter.value++;

    const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const entryAbsPath = path.join(absPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        // Still show directory node, just don't recurse
        nodes.push({ name: entry.name, path: entryRelPath, type: "directory", children: [] });
        continue;
      }
      const children = await buildTree(entryAbsPath, entryRelPath, depth + 1, counter);
      nodes.push({ name: entry.name, path: entryRelPath, type: "directory", children });
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        const stat = await fs.stat(entryAbsPath);
        size = stat.size;
      } catch {
        // skip size
      }
      nodes.push({ name: entry.name, path: entryRelPath, type: "file", size });
    }
  }

  return nodes;
}

function getWorkspaceRoot(params: Record<string, unknown>): string {
  const cfg = loadConfig();
  const agentId = typeof params.agentId === "string" ? params.agentId : DEFAULT_AGENT_ID;
  return resolveAgentWorkspaceDir(cfg, agentId);
}

/** workspace.tree - returns recursive file tree of agent workspace. */
const workspaceTree: GatewayRequestHandler = async ({ params, respond }) => {
  const root = getWorkspaceRoot(params);

  try {
    await fs.access(root);
  } catch {
    respond(true, { root, tree: [] });
    return;
  }

  const counter: TreeCounter = { value: 0 };
  const tree = await buildTree(root, "", 0, counter);
  respond(true, { root, tree });
};

/** workspace.read - reads content of a single file. */
const workspaceRead: GatewayRequestHandler = async ({ params, respond }) => {
  const filePath = typeof params.path === "string" ? params.path : "";
  if (!filePath) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path required" });
    return;
  }

  const root = getWorkspaceRoot(params);
  const absPath = resolveAndGuard(root, filePath);
  if (!absPath) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path escapes workspace" });
    return;
  }

  try {
    const stat = await fs.stat(absPath);
    // Refuse to read files larger than 2MB
    if (stat.size > 2 * 1024 * 1024) {
      respond(false, undefined, { code: "TOO_LARGE", message: "file exceeds 2MB limit" });
      return;
    }

    const content = await fs.readFile(absPath, "utf-8");
    respond(true, {
      path: filePath,
      content,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      respond(false, undefined, { code: "NOT_FOUND", message: "file not found" });
    } else {
      respond(false, undefined, { code: "READ_ERROR", message: String(err) });
    }
  }
};

/** workspace.write - writes content to a file (creates parent dirs as needed). */
const workspaceWrite: GatewayRequestHandler = async ({ params, respond }) => {
  const filePath = typeof params.path === "string" ? params.path : "";
  const content = typeof params.content === "string" ? params.content : undefined;

  if (!filePath || content === undefined) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path and content required" });
    return;
  }

  const root = getWorkspaceRoot(params);
  const absPath = resolveAndGuard(root, filePath);
  if (!absPath) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path escapes workspace" });
    return;
  }

  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    respond(true, { path: filePath, written: true });
  } catch (err) {
    respond(false, undefined, { code: "WRITE_ERROR", message: String(err) });
  }
};

/** workspace.search - search file contents with string or regex. */
const workspaceSearch: GatewayRequestHandler = async ({ params, respond }) => {
  const query = typeof params.query === "string" ? params.query : "";
  if (!query) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "query required" });
    return;
  }

  const isRegex = params.regex === true;
  const caseSensitive = params.caseSensitive === true;
  const maxResults = typeof params.maxResults === "number" ? Math.min(params.maxResults, 200) : 200;
  const root = getWorkspaceRoot(params);

  let pattern: RegExp;
  try {
    const flags = caseSensitive ? "g" : "gi";
    pattern = isRegex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid regex" });
    return;
  }

  const results: { path: string; line: number; column: number; content: string }[] = [];

  async function searchDir(absDir: string, relDir: string) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const entryAbs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await searchDir(entryAbs, entryRel);
      } else if (entry.isFile()) {
        // Skip large files (>1MB)
        try {
          const stat = await fs.stat(entryAbs);
          if (stat.size > 1024 * 1024) continue;
        } catch {
          continue;
        }

        let content: string;
        try {
          content = await fs.readFile(entryAbs, "utf-8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          pattern.lastIndex = 0;
          const match = pattern.exec(lines[i]);
          if (match) {
            results.push({
              path: entryRel,
              line: i + 1,
              column: match.index + 1,
              content: lines[i].length > 200 ? lines[i].slice(0, 200) : lines[i],
            });
          }
        }
      }
    }
  }

  try {
    await fs.access(root);
    await searchDir(root, "");
  } catch {
    // root doesn't exist
  }

  respond(true, { results });
};

/** workspace.stat - get metadata for a single path. */
const workspaceStat: GatewayRequestHandler = async ({ params, respond }) => {
  const filePath = typeof params.path === "string" ? params.path : "";
  if (!filePath) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path required" });
    return;
  }

  const root = getWorkspaceRoot(params);
  const absPath = resolveAndGuard(root, filePath);
  if (!absPath) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "path escapes workspace" });
    return;
  }

  try {
    const stat = await fs.stat(absPath);
    respond(true, {
      path: filePath,
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    });
  } catch {
    respond(false, undefined, { code: "NOT_FOUND", message: "path not found" });
  }
};

export const workspaceHandlers: GatewayRequestHandlers = {
  "workspace.tree": workspaceTree,
  "workspace.read": workspaceRead,
  "workspace.write": workspaceWrite,
  "workspace.stat": workspaceStat,
  "workspace.search": workspaceSearch,
};
