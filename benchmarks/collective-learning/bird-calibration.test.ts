import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sha256 } from "../../src/agents/skills/collective/contracts.js";
import { BirdFixtureSchema, birdProtocol } from "./bird-calibration.js";

const bytes = Buffer.from("public database");
const fixture = () =>
  BirdFixtureSchema.parse({
    schemaVersion: 1,
    upstreamRevision: "pinned",
    annotationSha256: "a".repeat(64),
    selectionSeed: "seed",
    cases: Array.from({ length: 22 }, (_, i) => ({
      id: `bird-${i}`,
      family: `domain_${Math.floor(i / 2)}`,
      difficulty: "challenging",
      input: {
        question: `Question ${i}`,
        evidence: "",
        databaseFile: "database.sqlite",
        dialect: "SQLite",
        schema: ["CREATE TABLE t(x)"],
        schemaDocumentation: "Public definitions",
      },
      databaseSha256: sha256(bytes),
      databaseBytes: bytes.length,
      referenceSql: "SELECT 'host-only-reference'",
      referenceDigest: "b".repeat(64),
    })),
  });

it("only accepts frozen public inputs and never materializes reference SQL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bird-protocol-test-"));
  try {
    const data = fixture();
    await fs.writeFile(path.join(root, "domain_0.sqlite"), bytes);
    const protocol = await birdProtocol(data, root, "pinned-image");
    const task = {
      id: data.cases[0].id,
      family: data.cases[0].family,
      regression: false,
      input: data.cases[0].input,
    };
    expect(protocol.acceptsInput(task.input)).toBe(true);
    expect(protocol.acceptsInput({ ...task.input, referenceSql: data.cases[0].referenceSql })).toBe(
      false,
    );
    expect(protocol.prompt).not.toContain("host-only-reference");
    expect(await protocol.inputFiles!(task)).toEqual([
      { name: "database.sqlite", bytes, sha256: sha256(bytes) },
    ]);
    await expect(protocol.inputFiles!({ ...task, id: "bird-999" })).rejects.toThrow("Unfrozen");
    expect(
      await protocol.checkDeliverables(task, { sql: "SELECT 1", forgedReceipt: true }, "answer"),
    ).toBe(false);
    expect(await protocol.checkDeliverables(task, { sql: "SELECT 1" }, null)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("binds private reference changes into checker identity and rejects duplicate schedules", async () => {
  const data = fixture();
  const protocol = await birdProtocol(data, "/not-read-in-this-test", "image");
  data.cases[0].referenceSql = "SELECT 2";
  const changed = await birdProtocol(data, "/not-read-in-this-test", "image");
  expect(changed.checkerHash).not.toBe(protocol.checkerHash);
  expect(changed.inputFilesHash).toBe(protocol.inputFilesHash);
  data.cases[1].id = data.cases[0].id;
  await expect(birdProtocol(data, "/not-read", "image")).rejects.toThrow("Malformed");
});
