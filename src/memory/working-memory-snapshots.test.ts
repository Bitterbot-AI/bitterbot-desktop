/**
 * Tests for working-memory snapshots, provenance, and rollback.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  snapshotWorkingMemory,
  listWorkingMemorySnapshots,
  readWorkingMemoryProvenance,
  restoreWorkingMemorySnapshot,
} from "./working-memory-snapshots.js";

describe("working-memory snapshots", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wm-snap-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const rewriteRecord = {
    event: "rewrite" as const,
    trigger: "cycle-1",
    synthesisModel: "test-model",
    wasHeuristicFallback: false,
    validation: { collapsed: false, valid: true, warnings: 0 },
    lengthBefore: 10,
    lengthAfter: 20,
  };

  it("snapshots previous state and records provenance", async () => {
    const file = await snapshotWorkingMemory(workspace, "# Old State\ncontent", rewriteRecord);
    expect(file).toMatch(/^MEMORY-.*\.md$/);

    const snapshots = await listWorkingMemorySnapshots(workspace);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.file).toBe(file);

    const provenance = await readWorkingMemoryProvenance(workspace);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({
      event: "rewrite",
      trigger: "cycle-1",
      snapshotFile: file,
      validation: { collapsed: false, valid: true, warnings: 0 },
    });
  });

  it("records provenance without a snapshot when previous state is empty", async () => {
    const file = await snapshotWorkingMemory(workspace, "", rewriteRecord);
    expect(file).toBeNull();
    expect(await listWorkingMemorySnapshots(workspace)).toHaveLength(0);
    const provenance = await readWorkingMemoryProvenance(workspace);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.snapshotFile).toBeNull();
  });

  it("prunes to the newest 10 snapshots", async () => {
    for (let i = 0; i < 13; i++) {
      await snapshotWorkingMemory(workspace, `state ${i}`, {
        ...rewriteRecord,
        trigger: `cycle-${i}`,
      });
      // Snapshot names are ISO-timestamp based; space them out
      await new Promise((r) => setTimeout(r, 5));
    }
    const snapshots = await listWorkingMemorySnapshots(workspace);
    expect(snapshots.length).toBeLessThanOrEqual(10);
    // Provenance keeps the full history even after pruning
    const provenance = await readWorkingMemoryProvenance(workspace);
    expect(provenance).toHaveLength(13);
  });

  it("restore round-trips MEMORY.md and is itself reversible", async () => {
    const memoryPath = path.join(workspace, "MEMORY.md");
    await fs.writeFile(memoryPath, "good state", "utf-8");
    const file = await snapshotWorkingMemory(workspace, "good state", rewriteRecord);
    await fs.writeFile(memoryPath, "bad rewrite", "utf-8");

    const result = await restoreWorkingMemorySnapshot(workspace);
    expect(result).toEqual({ restored: file });
    expect(await fs.readFile(memoryPath, "utf-8")).toBe("good state");

    // The restore snapshotted the bad state first, so it is recoverable too
    const provenance = await readWorkingMemoryProvenance(workspace);
    const restoreRecord = provenance.at(-1)!;
    expect(restoreRecord.event).toBe("restore");
    expect(restoreRecord.snapshotFile).not.toBeNull();
    const badSnapshot = await fs.readFile(
      path.join(workspace, "memory", "memory-snapshots", restoreRecord.snapshotFile!),
      "utf-8",
    );
    expect(badSnapshot).toBe("bad rewrite");
  });

  it("restore refuses path traversal and missing snapshots", async () => {
    expect(await restoreWorkingMemorySnapshot(workspace)).toEqual({
      error: "No working-memory snapshots available.",
    });
    expect(await restoreWorkingMemorySnapshot(workspace, "../MEMORY.md")).toEqual({
      error: "Invalid snapshot file name.",
    });
    expect(await restoreWorkingMemorySnapshot(workspace, "MEMORY-nope.md")).toEqual({
      error: "Snapshot not found: MEMORY-nope.md",
    });
  });
});
