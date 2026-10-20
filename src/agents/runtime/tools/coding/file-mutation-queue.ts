/**
 * PLAN-52 Phase 5: per-file serialization of write and edit calls.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/tools/file-mutation-queue.ts`: `withFileMutationQueue`.
 *
 * Differences from the original:
 *
 * 1. The queue map is this module's own. While pi-coding-agent is still
 *    installed, a mutation made through pi's copy of the tools is not
 *    serialized against one made through this copy. The gateway only builds
 *    its file tools from this directory, so there is one queue in practice.
 *
 * The queue key is the real path of the file when it exists (so a symlink and
 * its target share a queue), otherwise the resolved path.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
