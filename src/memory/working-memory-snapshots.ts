/**
 * Working-memory snapshots, provenance, and rollback.
 *
 * Every MEMORY.md rewrite snapshots the previous state and appends a
 * structured provenance record (what triggered the rewrite and how it went),
 * so state-vector updates are evidence-backed and reversible instead of
 * lossy overwrites.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_DIR_SEGMENTS = ["memory", "memory-snapshots"] as const;
const PROVENANCE_FILE = "provenance.jsonl";
const SNAPSHOT_PREFIX = "MEMORY-";
const MAX_SNAPSHOTS = 10;

export type WorkingMemoryProvenance = {
  timestamp: number;
  /** "rewrite" = normal synthesis overwrite; "restore" = rollback to a snapshot. */
  event: "rewrite" | "restore";
  /** Dream cycle id, "first-breath-*", "event-<reason>", or restore source file. */
  trigger: string;
  synthesisModel?: string;
  wasHeuristicFallback?: boolean;
  validation?: {
    collapsed: boolean;
    valid: boolean;
    warnings: number;
    bondDriftRatio?: number;
  } | null;
  lengthBefore: number;
  lengthAfter: number;
  /** Snapshot file the previous state was saved to (null if there was none). */
  snapshotFile: string | null;
};

function snapshotDir(workspaceDir: string): string {
  return path.join(workspaceDir, ...SNAPSHOT_DIR_SEGMENTS);
}

function memoryMdPath(workspaceDir: string): string {
  return path.join(workspaceDir, "MEMORY.md");
}

const PROVENANCE_MAX_BYTES = 512_000;
const PROVENANCE_KEEP_LINES = 200;

async function appendProvenance(dir: string, record: WorkingMemoryProvenance): Promise<void> {
  const file = path.join(dir, PROVENANCE_FILE);
  await fs.appendFile(file, JSON.stringify(record) + "\n", "utf-8");
  // Rotate: keep the newest N records once the log grows past the cap
  try {
    const stat = await fs.stat(file);
    if (stat.size > PROVENANCE_MAX_BYTES) {
      const raw = await fs.readFile(file, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      await fs.writeFile(file, lines.slice(-PROVENANCE_KEEP_LINES).join("\n") + "\n", "utf-8");
    }
  } catch {
    // Rotation is best-effort
  }
}

async function pruneSnapshots(dir: string): Promise<void> {
  const entries = await fs.readdir(dir);
  const snapshots = entries
    .filter((e) => e.startsWith(SNAPSHOT_PREFIX) && e.endsWith(".md"))
    .toSorted(); // ISO timestamps in names sort chronologically
  while (snapshots.length > MAX_SNAPSHOTS) {
    const oldest = snapshots.shift()!;
    try {
      await fs.unlink(path.join(dir, oldest));
    } catch {
      break;
    }
  }
}

/**
 * Snapshot the previous MEMORY.md state and record provenance for the write
 * that is about to replace it. Returns the snapshot filename (null when there
 * was no previous state to save). Never throws — snapshot failure must not
 * block the synthesis write.
 */
export async function snapshotWorkingMemory(
  workspaceDir: string,
  previousState: string,
  record: Omit<WorkingMemoryProvenance, "timestamp" | "snapshotFile">,
): Promise<string | null> {
  try {
    const dir = snapshotDir(workspaceDir);
    await fs.mkdir(dir, { recursive: true });

    let snapshotFile: string | null = null;
    if (previousState.trim().length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      snapshotFile = `${SNAPSHOT_PREFIX}${stamp}.md`;
      await fs.writeFile(path.join(dir, snapshotFile), previousState, "utf-8");
      await pruneSnapshots(dir);
    }

    await appendProvenance(dir, { ...record, timestamp: Date.now(), snapshotFile });
    return snapshotFile;
  } catch {
    return null;
  }
}

/** List available snapshots, newest first. */
export async function listWorkingMemorySnapshots(
  workspaceDir: string,
): Promise<Array<{ file: string; savedAt: string; bytes: number }>> {
  try {
    const dir = snapshotDir(workspaceDir);
    const entries = await fs.readdir(dir);
    const snapshots = entries
      .filter((e) => e.startsWith(SNAPSHOT_PREFIX) && e.endsWith(".md"))
      .toSorted()
      .toReversed();
    const out: Array<{ file: string; savedAt: string; bytes: number }> = [];
    for (const file of snapshots) {
      try {
        const stat = await fs.stat(path.join(dir, file));
        out.push({ file, savedAt: stat.mtime.toISOString(), bytes: stat.size });
      } catch {
        // Skip unreadable entries
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Read provenance records, newest last. Returns [] when none exist. */
export async function readWorkingMemoryProvenance(
  workspaceDir: string,
  limit = 50,
): Promise<WorkingMemoryProvenance[]> {
  try {
    const raw = await fs.readFile(path.join(snapshotDir(workspaceDir), PROVENANCE_FILE), "utf-8");
    const records: WorkingMemoryProvenance[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as WorkingMemoryProvenance);
      } catch {
        // Skip corrupt lines
      }
    }
    return records.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Restore MEMORY.md from a snapshot (latest when no file given). The current
 * state is snapshotted first, so a restore is itself reversible.
 */
export async function restoreWorkingMemorySnapshot(
  workspaceDir: string,
  fileName?: string,
): Promise<{ restored: string } | { error: string }> {
  const dir = snapshotDir(workspaceDir);
  let target = fileName;
  if (!target) {
    const snapshots = await listWorkingMemorySnapshots(workspaceDir);
    target = snapshots[0]?.file;
  }
  if (!target) {
    return { error: "No working-memory snapshots available." };
  }
  // Refuse path traversal — snapshots live flat in the snapshot dir
  if (target.includes("/") || target.includes("\\") || target.includes("..")) {
    return { error: "Invalid snapshot file name." };
  }

  let snapshotContent: string;
  try {
    snapshotContent = await fs.readFile(path.join(dir, target), "utf-8");
  } catch {
    return { error: `Snapshot not found: ${target}` };
  }

  let currentState = "";
  try {
    currentState = await fs.readFile(memoryMdPath(workspaceDir), "utf-8");
  } catch {
    // No current MEMORY.md — restoring into a blank slate
  }

  await snapshotWorkingMemory(workspaceDir, currentState, {
    event: "restore",
    trigger: target,
    lengthBefore: currentState.length,
    lengthAfter: snapshotContent.length,
  });
  await fs.writeFile(memoryMdPath(workspaceDir), snapshotContent, "utf-8");
  return { restored: target };
}
