/**
 * PLAN-44 Phase 0: one atomic-write primitive for every skill-evolution
 * state file. Audit finding: pattern pages were atomic (wiki-store) but the
 * sampler cursor, lint state, evolution meta, and PURPOSE.md were plain
 * `writeFile`s — a crash mid-write of `.sampler-state.json` reset the cursor
 * to 0 and the 14-day fast-forward then discarded the whole window.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Write via tmp + rename so readers never observe a torn file. */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** JSON convenience: pretty-printed, atomic. */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2));
}
