import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROTOCOLS_FILENAME } from "../agents/workspace.js";
import { shortenHomePath } from "../utils.js";

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not initialized in this workspace yet.",
  "The biological memory system (crystals, dream engine, GCCRF curiosity) is a",
  "built-in subsystem — MEMORY.md and the identity files are generated on the",
  "first gateway run / dream cycle. If this persists, run `bitterbot onboard`",
  "or start the gateway once and let a maintenance tick populate the workspace.",
].join("\n");

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const memoryPaths = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];

  for (const memoryPath of memoryPaths) {
    try {
      await fs.promises.access(memoryPath);
      return false;
    } catch {
      // keep scanning
    }
  }

  const protocolsPath = path.join(workspaceDir, DEFAULT_PROTOCOLS_FILENAME);
  try {
    const content = await fs.promises.readFile(protocolsPath, "utf-8");
    if (/memory\.md/i.test(content)) {
      return false;
    }
  } catch {
    // no PROTOCOLS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

export type LegacyWorkspaceDetection = {
  activeWorkspace: string;
  legacyDirs: string[];
};

export function detectLegacyWorkspaceDirs(params: {
  workspaceDir: string;
}): LegacyWorkspaceDetection {
  const activeWorkspace = path.resolve(params.workspaceDir);
  const legacyDirs: string[] = [];
  return { activeWorkspace, legacyDirs };
}

export function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string {
  return [
    "Extra workspace directories detected (may contain old agent files):",
    ...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
    `Active workspace: ${shortenHomePath(detection.activeWorkspace)}`,
    "If unused, archive or move to Trash.",
  ].join("\n");
}
