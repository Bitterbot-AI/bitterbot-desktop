/**
 * PLAN-55 Phase 2: owner blocks in MEMORY.md are the owner's.
 *
 * Text the owner wraps in `<!-- owner -->` ... `<!-- /owner -->` is kept
 * verbatim by the dream rewrite (working-memory-canonical.ts). This guard
 * covers the other writer: the agent's own tools. Every tool call is
 * bracketed by a read of the workspace's MEMORY.md; if the call left the
 * owner blocks different (one added, removed or edited, by `write`, `edit`,
 * `apply_patch`, a shell redirect or anything else), the owner blocks are
 * put back exactly as they were and any block the call invented is removed.
 * The rest of the agent's edit stands, and the tool result says what
 * happened.
 *
 * The owner's own saves through the Control UI (agents.files.set) are
 * recognised (noteMemoryWrittenByUser) and left alone, like the GENOME guard.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { extractOwnerSections, preserveOwnerSections } from "../memory/working-memory-canonical.js";
import { carryToolMarkers, type AnyAgentTool } from "./agent-tools.types.js";
import { DEFAULT_MEMORY_FILENAME } from "./workspace.js";

const log = createSubsystemLogger("agents/memory-owner-guard");

const MEMORY_OWNER_GUARD_WRAPPED = Symbol("memoryOwnerGuardWrapped");
/** MEMORY.md is a few KB; anything larger is not read into memory. */
const MAX_MEMORY_BYTES = 1024 * 1024;
const USER_WRITE_TTL_MS = 60 * 60_000;

export const MEMORY_OWNER_RESTORED_NOTICE =
  "[memory-owner-guard] This tool call changed an owner block (<!-- owner --> ... <!-- /owner -->) in MEMORY.md. Owner blocks are the user's; they have been put back exactly as they were. The rest of the change was kept.";

const userWrites = new Map<string, { digest: string; at: number }>();
const digestOf = (content: string) => crypto.createHash("sha256").update(content).digest("hex");

/** Record that the owner saved this content to MEMORY.md (Control UI file editor). */
export function noteMemoryWrittenByUser(file: string, content: string): void {
  const now = Date.now();
  for (const [key, entry] of userWrites) {
    if (now - entry.at > USER_WRITE_TTL_MS) {
      userWrites.delete(key);
    }
  }
  userWrites.set(path.resolve(file), { digest: digestOf(content), at: now });
}

function writtenByUser(file: string, content: string): boolean {
  const entry = userWrites.get(path.resolve(file));
  return Boolean(
    entry && Date.now() - entry.at <= USER_WRITE_TTL_MS && entry.digest === digestOf(content),
  );
}

async function readMemory(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES) {
      return null;
    }
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

const sameBlocks = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].toSorted().every((x, i) => x === [...b].toSorted()[i]);

/**
 * Compare owner blocks before and after; repair when they differ. Returns
 * true when the file was repaired.
 */
export async function repairOwnerBlocks(file: string, before: string | null): Promise<boolean> {
  const after = await readMemory(file);
  const beforeBlocks = extractOwnerSections(before ?? "");
  if (after === null) {
    // Deleted (or made unreadable): put the previous file back if it had owner blocks.
    if (before !== null && beforeBlocks.length > 0) {
      await fs.writeFile(file, before, "utf-8");
      log.warn(`a tool call deleted ${file}, which holds owner blocks; restored`);
      return true;
    }
    return false;
  }
  const afterBlocks = extractOwnerSections(after);
  if (sameBlocks(beforeBlocks, afterBlocks) || writtenByUser(file, after)) {
    return false;
  }
  const repaired = preserveOwnerSections(before ?? "", after);
  if (repaired === after) {
    return false;
  }
  await fs.writeFile(file, repaired, "utf-8");
  log.warn(`a tool call changed owner blocks in ${file}; owner blocks restored`);
  return true;
}

function withNotice(result: unknown): unknown {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const typed = result as { content: unknown[] };
    return {
      ...typed,
      content: [...typed.content, { type: "text", text: MEMORY_OWNER_RESTORED_NOTICE }],
    };
  }
  return { content: [{ type: "text", text: MEMORY_OWNER_RESTORED_NOTICE }], details: result };
}

export function wrapToolWithMemoryOwnerGuard(
  tool: AnyAgentTool,
  workspaceDir?: string,
): AnyAgentTool {
  const execute = tool.execute;
  if (!workspaceDir || !execute) {
    return tool;
  }
  if ((tool as unknown as Record<symbol, unknown>)[MEMORY_OWNER_GUARD_WRAPPED]) {
    return tool;
  }
  const file = path.resolve(workspaceDir, DEFAULT_MEMORY_FILENAME);
  const wrapped: AnyAgentTool = carryToolMarkers<AnyAgentTool>(tool, {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const before = await readMemory(file);
      let result: Awaited<ReturnType<typeof execute>>;
      try {
        result = await execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        await repairOwnerBlocks(file, before).catch(() => false);
        throw err;
      }
      let repaired = false;
      try {
        repaired = await repairOwnerBlocks(file, before);
      } catch (err) {
        log.error(`could not repair owner blocks in ${file}: ${String(err)}`);
      }
      return (repaired ? withNotice(result) : result) as Awaited<ReturnType<typeof execute>>;
    },
  });
  Object.defineProperty(wrapped, MEMORY_OWNER_GUARD_WRAPPED, { value: true, enumerable: false });
  return wrapped;
}
