/**
 * PLAN-45 4.2 (adversarial 4-9b): a peer skill promoted while the skill
 * network bridge was not active has no memory chunk, so it is invisible to
 * the attestation sweep and the exchange. Retry each housekeeping pass.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { type EvolutionMeta, writePeerChunk } from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/peer-chunks");

export async function retryPendingPeerChunks(
  opts: ImpactTrailOptions = {},
): Promise<{ retried: number; written: number }> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let names: string[];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return { retried: 0, written: 0 };
  }
  const out = { retried: 0, written: 0 };
  for (const name of names) {
    const dir = path.join(roots.liveRoot, name);
    let meta: EvolutionMeta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, ".evolution-meta.json"), "utf-8"));
    } catch {
      continue;
    }
    if (meta.origin !== "peer" || !meta.peer?.chunkPending) {
      continue;
    }
    out.retried += 1;
    const result = await writePeerChunk(dir);
    if (result === "written") {
      out.written += 1;
      const { chunkPending: _done, ...peer } = meta.peer;
      await atomicWriteJson(path.join(dir, ".evolution-meta.json"), { ...meta, peer });
      log.info(`peer chunk written on retry: ${name}`);
    } else {
      await atomicWriteJson(path.join(dir, ".evolution-meta.json"), {
        ...meta,
        peer: { ...meta.peer, chunkPending: result },
      });
    }
  }
  return out;
}
