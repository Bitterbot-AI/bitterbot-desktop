import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sha256 } from "../../src/agents/skills/collective/contracts.js";
import { sqlLearningProtocol, type SqlLearningCase } from "./sql-learning.js";

const bytes = Buffer.from("visible database");
const item = (): SqlLearningCase => ({
  id: "example",
  family: "hospital",
  kind: "entity-mean",
  input: { question: "Compute the entity mean", schema: ["public schema"] },
  referenceSql: "host-only reference",
  snapshots: [
    { file: "visible.sqlite", sha256: sha256(bytes), bytes: bytes.length, digest: "a".repeat(64) },
    { file: "hidden.sqlite", sha256: "b".repeat(64), bytes: 20, digest: "c".repeat(64) },
  ],
});

it("exposes only the visible snapshot and binds every hidden snapshot to the checker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sql-learning-boundary-"));
  try {
    await fs.writeFile(path.join(root, "visible.sqlite"), bytes);
    const data = item(),
      protocol = await sqlLearningProtocol([data], root, "image");
    const task = { id: data.id, family: data.family, input: data.input, regression: false };
    expect(await protocol.inputFiles!(task)).toEqual([
      { name: "database.sqlite", bytes, sha256: sha256(bytes) },
    ]);
    expect(protocol.prompt).not.toContain(data.referenceSql);
    expect(protocol.acceptsInput({ ...data.input, expected: 2 })).toBe(false);
    await expect(protocol.inputFiles!({ ...task, id: "other" })).rejects.toThrow("Unfrozen");
    expect(
      await protocol.checkDeliverables(task, { sql: "SELECT 1", verdict: "pass" }, "note"),
    ).toBe(false);
    data.snapshots[1].digest = "d".repeat(64);
    const revised = await sqlLearningProtocol([data], root, "image");
    expect(revised.checkerHash).not.toBe(protocol.checkerHash);
    expect(revised.inputFilesHash).toBe(protocol.inputFilesHash);
    await expect(sqlLearningProtocol([data, data], root, "image")).rejects.toThrow("Duplicate");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
