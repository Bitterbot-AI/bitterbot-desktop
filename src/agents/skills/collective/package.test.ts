import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import { learningHash, lineageId } from "./contracts.js";
import { assertPackagePath, diffPackages, screenPackage, snapshotPackage } from "./package.js";
import { signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  databases.splice(0).forEach((d) => d.close());
  for (const d of directories.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collective-package-"));
  directories.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: research-brief\ndescription: Prepare a source-backed research brief.\n---\nRead the provided sources. Run scripts/check.mjs to check source dates, then write the research brief with citations and uncertainties.\n",
  );
  await fs.writeFile(path.join(source, "scripts/check.mjs"), "export const version = 1;\n");
  const metadata = {
    name: "research-brief",
    description: "Prepare a source-backed research brief.",
    requirements: { platforms: [], tools: {}, capabilities: [], runtime: {} },
  };
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return { root, source, metadata, store: new CollectiveSkillStore(db, path.join(root, "store")) };
}
describe("complete skill packages", () => {
  it("keeps interrupted installation invisible and retries the identical snapshot", async () => {
    const f = await fixture(),
      snapshot = await snapshotPackage(f.source, f.metadata);
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("interrupted install"));
    try {
      await expect(f.store.install(snapshot)).rejects.toThrow("interrupted install");
    } finally {
      rename.mockRestore();
    }
    expect(f.store.get(snapshot.packageHash)).toBeNull();
    expect(await fs.readdir(path.join(f.store.root, "staging"))).toEqual([]);
    await f.store.install(snapshot);
    expect((await f.store.read(snapshot.packageHash)).packageHash).toBe(snapshot.packageHash);
  });
  it.each([
    "../escape",
    "/absolute",
    "C:/escape",
    "a\\b",
    "CON.txt",
    "nul",
    "file.",
    "file ",
    "x:y",
    "a//b",
    "e\u0301.md",
    "a/../b",
  ])("rejects nonportable path %s", (value) => expect(() => assertPackagePath(value)).toThrow());
  it("binds helpers and requirements, snapshots bytes, and reports omissions", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.source, "node_modules"));
    const a = await snapshotPackage(f.source, f.metadata, ["scripts/check.mjs"]);
    screenPackage(a);
    expect(a.omitted).toEqual(["node_modules"]);
    await fs.writeFile(path.join(f.source, "scripts/check.mjs"), "export const version = 2;\n");
    const b = await snapshotPackage(f.source, f.metadata);
    expect(b.packageHash).not.toBe(a.packageHash);
    expect(a.files.get("scripts/check.mjs")!.toString()).toContain("version = 1");
    expect(diffPackages(a.manifest, b.manifest)).toEqual([
      { path: "scripts/check.mjs", change: "changed" },
    ]);
    const c = await snapshotPackage(f.source, {
      ...f.metadata,
      requirements: { ...f.metadata.requirements, tools: { fetch: "2" } },
    });
    expect(c.packageHash).not.toBe(b.packageHash);
    await expect(snapshotPackage(f.source, f.metadata, ["missing.mjs"])).rejects.toThrow(
      "Missing declared dependency",
    );
  });
  it("rejects hard links, secrets and oversized trees", async () => {
    const f = await fixture();
    await fs.link(path.join(f.source, "scripts/check.mjs"), path.join(f.source, "linked.mjs"));
    await expect(snapshotPackage(f.source, f.metadata)).rejects.toThrow("Links");
    await fs.unlink(path.join(f.source, "linked.mjs"));
    await fs.writeFile(path.join(f.source, "credentials.txt"), "-----BEGIN PRIVATE KEY-----");
    const secret = await snapshotPackage(f.source, f.metadata);
    expect(() => screenPackage(secret)).toThrow("credential");
    await fs.unlink(path.join(f.source, "credentials.txt"));
    await fs.writeFile(path.join(f.source, "huge.bin"), Buffer.alloc(10 * 1024 * 1024));
    await expect(snapshotPackage(f.source, f.metadata)).rejects.toThrow("limits");
  });
  it("installs frozen packages and atomically activates and rolls back every file", async () => {
    const f = await fixture();
    const a = await snapshotPackage(f.source, f.metadata);
    await f.store.install(a);
    await f.store.screen(a.packageHash);
    const key = generateKeyPair();
    const first = signRelease(
      {
        protocol: "bitterbot/skill-release/1",
        publisher: `ed25519:${key.publicKeyHex}`,
        skillId: "brief",
        version: 1,
        packageHash: a.packageHash,
        previousRelease: null,
        parents: [],
        scope: { kind: "public" },
        issuedAt: Date.now(),
      },
      key,
    );
    f.store.addRelease(first);
    expect(() => f.store.activate("main", first, "env")).toThrow("validation");
    f.store.state(a.packageHash, "locally-validated", null, "env");
    f.store.activate("main", first, "env");
    f.store.state(a.packageHash, "stable");
    await fs.writeFile(path.join(f.source, "scripts/check.mjs"), "export const version = 2;\n");
    const b = await snapshotPackage(f.source, f.metadata);
    await f.store.install(b);
    f.store.state(b.packageHash, "locally-validated", null, "env");
    const second = signRelease(
      {
        ...first,
        version: 2,
        packageHash: b.packageHash,
        previousRelease: learningHash(first),
        parents: [a.packageHash],
      },
      key,
    );
    f.store.pin("main", lineageId(first), true);
    expect(() => f.store.activate("main", second, "env")).toThrow("pinned");
    f.store.pin("main", lineageId(first), false);
    const interrupted = vi.spyOn(f.store, "audit").mockImplementationOnce(() => {
      throw new Error("interrupted transaction");
    });
    expect(() => f.store.activate("main", second, "env")).toThrow("interrupted transaction");
    interrupted.mockRestore();
    expect(f.store.active("main", lineageId(first))?.hash).toBe(a.packageHash);
    expect(f.store.get(b.packageHash)?.state).toBe("locally-validated");
    f.store.activate("main", second, "env");
    const rollbackInterrupted = vi.spyOn(f.store, "audit").mockImplementationOnce(() => {
      throw new Error("interrupted rollback");
    });
    expect(() => f.store.rollback("main", lineageId(first), "env", "regression")).toThrow(
      "interrupted rollback",
    );
    rollbackInterrupted.mockRestore();
    expect(f.store.active("main", lineageId(first))?.hash).toBe(b.packageHash);
    f.store.rollback("main", lineageId(first), "env", "regression");
    expect(f.store.active("main", lineageId(first))?.hash).toBe(a.packageHash);
    expect(
      (await f.store.read(a.packageHash)).files.get("scripts/check.mjs")!.toString(),
    ).toContain("version = 1");
    expect(
      (await f.store.read(b.packageHash)).files.get("scripts/check.mjs")!.toString(),
    ).toContain("version = 2");
  });
  it("detects a modified installed helper before reuse", async () => {
    const f = await fixture(),
      snapshot = await snapshotPackage(f.source, f.metadata);
    await f.store.install(snapshot);
    const file = path.join(f.store.directory(snapshot.packageHash), "content/scripts/check.mjs");
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, "tampered");
    await expect(f.store.read(snapshot.packageHash)).rejects.toThrow("modified");
  });
});
