import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { scanSkillForInjection } from "../../../security/skill-injection-scanner.js";
import { runSkillGate } from "../skill-gate.js";
import {
  ManifestSchema,
  PACKAGE_LIMITS,
  packageHash,
  sha256,
  type PackageSnapshot,
  type SkillPackageManifest,
} from "./contracts.js";

const OMIT = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".pytest_cache",
]);
const SECRET =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{20,}/i;

export function assertPackagePath(value: string): void {
  const parts = value.split("/");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) throw new Error("Control character in package path");
  }
  if (
    !value ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value) > 200 ||
    parts.length > PACKAGE_LIMITS.depth + 1 ||
    /[\\:]|%[a-f0-9]{2}|[\uD800-\uDFFF]/i.test(value) ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /[<>"|?*]/.test(p) ||
        /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(`Unsafe package path: ${value}`);
}

export function validateManifest(input: unknown): SkillPackageManifest {
  const manifest = ManifestSchema.parse(input);
  const paths = new Set<string>();
  let size = 0;
  for (const file of manifest.files) {
    assertPackagePath(file.path);
    const key = file.path.toUpperCase().toLowerCase().normalize("NFC");
    if (paths.has(key)) throw new Error("Colliding package paths");
    paths.add(key);
    size += file.size;
  }
  for (const name of paths) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/"))) throw new Error("File/directory collision");
  }
  if (size > PACKAGE_LIMITS.bytes || !manifest.files.some((f) => f.path === "SKILL.md"))
    throw new Error("Incomplete or oversized package");
  const sorted = manifest.files.toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (manifest.files.some((f, i) => f.path !== sorted[i].path))
    throw new Error("Manifest files must be sorted");
  return manifest;
}

export function verifySnapshot(snapshot: PackageSnapshot): void {
  const manifest = validateManifest(snapshot.manifest);
  if (
    packageHash(manifest) !== snapshot.packageHash ||
    snapshot.files.size !== manifest.files.length
  )
    throw new Error("Package hash mismatch");
  for (const file of manifest.files) {
    const bytes = snapshot.files.get(file.path);
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.hash)
      throw new Error(`File hash mismatch: ${file.path}`);
  }
}

/** Scans the frozen bytes, never the mutable source directory. */
export function screenPackage(snapshot: PackageSnapshot): void {
  verifySnapshot(snapshot);
  const gate = runSkillGate({
    skillName: snapshot.manifest.name,
    stagedContent: snapshot.files.get("SKILL.md")!.toString("utf8"),
  });
  if (gate.outcome !== "pass")
    throw new Error(`Package requires review: ${gate.issues.map((i) => i.kind).join(", ")}`);
  for (const [name, bytes] of snapshot.files) {
    if (
      /(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(name) ||
      SECRET.test(bytes.toString("utf8"))
    )
      throw new Error(`Possible credential in ${name}`);
    if (
      /\.(?:exe|dll|so|dylib|com|msi)$/i.test(name) ||
      [
        "4d5a",
        "7f454c46",
        "feedfa",
        "cffaedfe",
        "cefaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
        "0061736d",
      ].some((magic) => bytes.subarray(0, magic.length / 2).toString("hex") === magic)
    )
      throw new Error(`Compiled executable refused: ${name}`);
    if (scanSkillForInjection(bytes.toString("utf8")).severity === "critical")
      throw new Error(`Unsafe package content: ${name}`);
  }
}

/** A bounded, race-checked snapshot. No links within the selected package are followed. */
export async function snapshotPackage(
  root: string,
  metadata: Omit<SkillPackageManifest, "schemaVersion" | "entrypoint" | "files">,
  dependencies: string[] = [],
): Promise<PackageSnapshot> {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Package root must be a real directory");
  // Host-selected ancestors may use OS aliases (macOS /var -> /private/var).
  // Pin their canonical location once; retain strict checks inside the package.
  root = await fs.realpath(root);
  const canonicalRootStat = await fs.lstat(root);
  if (canonicalRootStat.dev !== rootStat.dev || canonicalRootStat.ino !== rootStat.ino)
    throw new Error("Package root changed during snapshot");
  const files = new Map<string, Buffer>();
  const entries: SkillPackageManifest["files"] = [];
  const omitted: string[] = [];
  let total = 0;
  let visited = 0;
  async function walk(relative: string): Promise<void> {
    const directory = path.join(root, relative);
    const before = await fs.lstat(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("Directory changed during snapshot");
    for await (const item of await fs.opendir(directory)) {
      if (++visited > PACKAGE_LIMITS.files * (PACKAGE_LIMITS.depth + 1))
        throw new Error("Package metadata limits exceeded");
      const name = relative ? `${relative}/${item.name}` : item.name;
      assertPackagePath(name);
      const filename = path.join(root, name);
      const stat = await fs.lstat(filename);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new Error(`Links and special files refused: ${name}`);
      if (OMIT.has(item.name.toLowerCase()) || /\.pyc$/i.test(name)) {
        omitted.push(name);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(name);
        continue;
      }
      if (++total > PACKAGE_LIMITS.files || stat.size > PACKAGE_LIMITS.bytes)
        throw new Error("Package limits exceeded");
      if ((await fs.realpath(filename)) !== filename) throw new Error("Package path changed");
      const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.nlink !== 1 ||
          !opened.isFile()
        )
          throw new Error("File changed during snapshot");
        const bytes = Buffer.alloc(stat.size + 1);
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(bytes, read, bytes.length - read, read);
          if (!result.bytesRead) break;
          read += result.bytesRead;
        }
        const after = await handle.stat();
        if (
          read !== stat.size ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs ||
          (await fs.realpath(filename)) !== filename
        )
          throw new Error("File changed during snapshot");
        const body = bytes.subarray(0, read);
        files.set(name, body);
        entries.push({
          path: name,
          hash: sha256(body),
          size: read,
          executable: (stat.mode & 0o111) !== 0,
        });
        if (entries.reduce((n, f) => n + f.size, 0) > PACKAGE_LIMITS.bytes)
          throw new Error("Package limits exceeded");
      } finally {
        await handle.close();
      }
    }
    const after = await fs.lstat(directory);
    if (
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("Directory changed during snapshot");
  }
  await walk("");
  for (const dependency of dependencies) {
    assertPackagePath(dependency);
    if (!files.has(dependency)) throw new Error(`Missing declared dependency: ${dependency}`);
  }
  const manifest = validateManifest({
    ...metadata,
    schemaVersion: 1,
    entrypoint: "SKILL.md",
    files: entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  const snapshot = { packageHash: packageHash(manifest), manifest, files, omitted };
  verifySnapshot(snapshot);
  return snapshot;
}

export function diffPackages(before: SkillPackageManifest | null, after: SkillPackageManifest) {
  const prior = new Map(before?.files.map((f) => [f.path, f]) ?? []);
  const changes: Array<{ path: string; change: "added" | "changed" | "removed" }> = [];
  for (const file of after.files) {
    const old = prior.get(file.path);
    if (!old) changes.push({ path: file.path, change: "added" });
    else if (old.hash !== file.hash || old.executable !== file.executable)
      changes.push({ path: file.path, change: "changed" });
    prior.delete(file.path);
  }
  for (const name of prior.keys()) changes.push({ path: name, change: "removed" });
  return changes;
}
