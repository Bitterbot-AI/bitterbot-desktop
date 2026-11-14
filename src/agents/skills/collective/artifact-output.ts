import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./contracts.js";

export type ArtifactOutputSpec = { name: string; maxBytes: number };
export type CapturedArtifact = { name: string; sha256: string; bytes: Buffer };
export type ArtifactCheckOutcome = boolean | "infrastructure" | "checker-invalid";

/** Trusted checker subprocesses receive cancellation; timeout is never a task-failure verdict. */
export function runBoundedArtifactCheck(
  check: (signal: AbortSignal) => ArtifactCheckOutcome | Promise<ArtifactCheckOutcome>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ArtifactCheckOutcome> {
  if (signal.aborted) return Promise.resolve("infrastructure");
  return new Promise((resolve) => {
    const controller = new AbortController();
    let finished = false;
    const settle = (value: ArtifactCheckOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      controller.abort();
      settle("infrastructure");
    };
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => check(controller.signal))
      .then(settle, () => settle("checker-invalid"));
  });
}

/** Operator-owned declarations only. No recursive directory walks or model-selected paths. */
export function validArtifactOutputs(files: readonly ArtifactOutputSpec[]): boolean {
  if (!files.length || files.length > 16) return false;
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}\.[a-z0-9]{1,12}$/.test(file.name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./.test(file.name) ||
      ["sources.json", "session.jsonl"].includes(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.maxBytes) ||
      file.maxBytes < 1 ||
      file.maxBytes > 4 * 1024 * 1024
    )
      return false;
    names.add(file.name);
    total += file.maxBytes;
  }
  return total <= 16 * 1024 * 1024;
}

/** Snapshot bytes before checking or archiving; later workspace writes cannot change a verdict. */
export async function captureArtifacts(
  workspace: string,
  files: readonly ArtifactOutputSpec[],
): Promise<CapturedArtifact[]> {
  if (!validArtifactOutputs(files)) throw new Error("Invalid host artifact declarations");
  const root = await fs.realpath(workspace);
  const captured: CapturedArtifact[] = [];
  for (const file of files) {
    const filename = path.join(root, file.name);
    const initial = await fs.lstat(filename);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.nlink !== 1 ||
      initial.size > file.maxBytes ||
      (await fs.realpath(filename)) !== filename
    )
      throw new Error("Unsafe or oversized artifact");
    // O_NONBLOCK prevents a raced FIFO from hanging the host; NOFOLLOW refuses a raced symlink.
    const flags =
      constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = await fs.open(filename, flags);
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== initial.dev ||
        before.ino !== initial.ino ||
        before.size !== initial.size ||
        before.size > file.maxBytes
      )
        throw new Error("Artifact changed before capture");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("Artifact truncated during capture");
        offset += bytesRead;
      }
      const after = await handle.stat();
      const current = await fs.lstat(filename);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.nlink !== 1 ||
        current.isSymbolicLink() ||
        current.ino !== before.ino ||
        current.dev !== before.dev
      )
        throw new Error("Artifact changed during capture");
      captured.push({ name: file.name, bytes, sha256: sha256(bytes) });
    } finally {
      await handle.close();
    }
  }
  return captured;
}
