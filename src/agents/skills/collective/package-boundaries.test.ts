import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_LIMITS, packageHash, sha256, type SkillPackageManifest } from "./contracts.js";
import { snapshotPackage, validateManifest, verifySnapshot } from "./package.js";

const temporary: string[] = [];
const metadata = {
  name: "boundary-fixture",
  description: "Exercise complete package boundaries.",
  requirements: { platforms: [], tools: {}, capabilities: [], runtime: {} },
};
const entry = (name: string, size = 1) => ({
  path: name,
  hash: sha256("x"),
  size,
  executable: false,
});
function manifest(files = [entry("SKILL.md")]): SkillPackageManifest {
  return { ...metadata, schemaVersion: 1, entrypoint: "SKILL.md", files };
}
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-boundaries-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("untrusted package manifests", () => {
  it.each([
    ["duplicate paths", [entry("SKILL.md"), entry("SKILL.md")]],
    ["case-folded paths", [entry("SKILL.md"), entry("skill.md")]],
    ["Unicode case-folded paths", [entry("SKILL.md"), entry("STRASSE.py"), entry("straße.py")]],
    ["file/directory collisions", [entry("SKILL.md"), entry("helpers"), entry("helpers/run.py")]],
    [
      "case-folded directory collisions",
      [entry("SKILL.md"), entry("Tools"), entry("tools/run.py")],
    ],
  ])("rejects %s without relying on filesystem case sensitivity", (_label, files) => {
    expect(() => validateManifest(manifest(files))).toThrow(/Colliding|collision/);
  });

  it.each([
    ["wrong entrypoint", { ...manifest(), entrypoint: "instructions.md" }],
    ["missing entrypoint", manifest([entry("helper.py")])],
    ["unsorted files", manifest([entry("helper.py"), entry("SKILL.md")])],
    ["negative file size", manifest([entry("SKILL.md", -1)])],
    ["fractional file size", manifest([entry("SKILL.md", 1.5)])],
    ["invalid file hash", manifest([{ ...entry("SKILL.md"), hash: "not-a-hash" }])],
    ["unexpected execution metadata", { ...manifest(), setupCommand: "run-setup" }],
    ["distribution metadata in manifest", { ...manifest(), scope: { kind: "public" } }],
  ])("rejects malformed manifest: %s", (_label, value) => {
    expect(() => validateManifest(value)).toThrow();
  });

  it("enforces exact file, byte and directory-depth boundaries", () => {
    const files = [
      entry("SKILL.md"),
      ...Array.from({ length: PACKAGE_LIMITS.files - 1 }, (_, i) =>
        entry(`f${String(i).padStart(3, "0")}`),
      ),
    ];
    expect(validateManifest(manifest(files)).files).toHaveLength(PACKAGE_LIMITS.files);
    expect(() => validateManifest(manifest([...files, entry("overflow")]))).toThrow();
    expect(validateManifest(manifest([entry("SKILL.md", PACKAGE_LIMITS.bytes)]))).toBeTruthy();
    expect(() =>
      validateManifest(manifest([entry("SKILL.md", PACKAGE_LIMITS.bytes + 1)])),
    ).toThrow();
    const nested = `${"d/".repeat(PACKAGE_LIMITS.depth)}file`;
    expect(validateManifest(manifest([entry("SKILL.md"), entry(nested)]))).toBeTruthy();
    expect(() => validateManifest(manifest([entry("SKILL.md"), entry(`d/${nested}`)]))).toThrow();
  });

  it("has deterministic hashes for reordered keys and binds executable flags", () => {
    const first = manifest();
    first.requirements = {
      platforms: ["linux"],
      capabilities: ["read"],
      tools: { read: "1", exec: "2" },
      runtime: { python: "3.11", node: "22" },
    };
    const reordered = {
      files: first.files,
      entrypoint: first.entrypoint,
      schemaVersion: first.schemaVersion,
      description: first.description,
      name: first.name,
      requirements: {
        runtime: { node: "22", python: "3.11" },
        tools: { exec: "2", read: "1" },
        capabilities: ["read"],
        platforms: ["linux"],
      },
    };
    expect(packageHash(reordered)).toBe(packageHash(first));
    expect(packageHash({ ...first, files: [{ ...first.files[0], executable: true }] })).not.toBe(
      packageHash(first),
    );
  });

  it("rejects helper tampering even when the entrypoint and manifest remain unchanged", () => {
    const original = manifest([entry("SKILL.md"), entry("helper.py")]);
    const snapshot = {
      manifest: original,
      packageHash: packageHash(original),
      omitted: [],
      files: new Map([
        ["SKILL.md", Buffer.from("x")],
        ["helper.py", Buffer.from("x")],
      ]),
    };
    expect(() => verifySnapshot(snapshot)).not.toThrow();
    snapshot.files.set("helper.py", Buffer.from("y"));
    expect(() => verifySnapshot(snapshot)).toThrow("File hash mismatch: helper.py");
  });
});

describe("filesystem package boundaries", () => {
  it("refuses directory symlinks and Windows junctions at the root and inside the package", async () => {
    const root = await directory();
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(source, "SKILL.md"), "x");
    await fs.writeFile(path.join(outside, "private.txt"), "must not enter the package");
    const kind = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(source, path.join(root, "linked-root"), kind);
    await expect(snapshotPackage(path.join(root, "linked-root"), metadata)).rejects.toThrow(
      "real directory",
    );
    await fs.symlink(outside, path.join(source, "helpers"), kind);
    await expect(snapshotPackage(source, metadata)).rejects.toThrow("Links");
    expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe(
      "must not enter the package",
    );
  });

  it("reports omitted dependency directories and refuses a declared dependency inside them", async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, "SKILL.md"), "x");
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules", "helper.py"), "x");
    const snapshot = await snapshotPackage(root, metadata);
    expect(snapshot.omitted).toEqual(["node_modules"]);
    expect([...snapshot.files.keys()]).toEqual(["SKILL.md"]);
    await expect(snapshotPackage(root, metadata, ["node_modules/helper.py"])).rejects.toThrow(
      "Missing declared dependency",
    );
  });

  it("accepts exactly 128 regular files and refuses the next file", async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, "SKILL.md"), "x");
    await Promise.all(
      Array.from({ length: PACKAGE_LIMITS.files - 1 }, (_, i) =>
        fs.writeFile(path.join(root, `helper-${i}`), "x"),
      ),
    );
    expect((await snapshotPackage(root, metadata)).files.size).toBe(PACKAGE_LIMITS.files);
    await fs.writeFile(path.join(root, "overflow"), "x");
    await expect(snapshotPackage(root, metadata)).rejects.toThrow("Package limits exceeded");
  });

  it.skipIf(process.platform === "win32")(
    "refuses special files before attempting to read them",
    async () => {
      const root = await directory();
      await fs.writeFile(path.join(root, "SKILL.md"), "x");
      execFileSync("mkfifo", [path.join(root, "pipe")]);
      await expect(snapshotPackage(root, metadata)).rejects.toThrow("special files refused");
    },
  );
});
