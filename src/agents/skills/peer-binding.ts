/**
 * PLAN-45 4.4: a live peer skill stays bound to the bytes its author
 * signed. `.provenance.json` records `content_hash` (sha256 of the SKILL.md
 * the envelope carried); if the live body no longer hashes to it, the copy
 * was edited locally after acceptance and is no longer the peer's skill.
 * The response is CANARY-OFF (withheld everywhere, files kept, reversible),
 * recorded in the impact trail; deletion stays operator-only.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canaryOff, isCanaryOff, readCanaryRegistry } from "./canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "./impact-trail.js";
import { resolveStorageRoots } from "./skill-storage.js";

export interface PeerBindingCheck {
  examined: number;
  tampered: string[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

export async function verifyPeerBindings(
  opts: ImpactTrailOptions & { now?: number } = {},
): Promise<PeerBindingCheck> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const trailOpts = opts.configDir ? { configDir: opts.configDir } : {};
  const now = opts.now ?? Date.now();
  const registry = await readCanaryRegistry(trailOpts);
  let names: string[];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return { examined: 0, tampered: [] };
  }
  const result: PeerBindingCheck = { examined: 0, tampered: [] };
  for (const name of names) {
    const dir = path.join(roots.liveRoot, name);
    let expected: string | null = null;
    let body: string;
    let prov: Record<string, unknown>;
    try {
      prov = JSON.parse(await fs.readFile(path.join(dir, ".provenance.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      if (
        typeof prov.content_hash !== "string" ||
        typeof prov.author_pubkey !== "string" ||
        !prov.author_pubkey
      ) {
        continue; // registry import or malformed: no peer binding to verify
      }
      expected = prov.content_hash;
      body = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }
    result.examined += 1;
    const actual = sha256Hex(body);
    const tamper = prov.tamper as { actual?: unknown } | undefined;
    if (
      actual === expected ||
      isCanaryOff(registry.skills[name]) ||
      // One-shot per byte state (adversarial 4-1): an operator who reversed
      // the demotion for these exact bytes is not re-flagged every pass.
      tamper?.actual === actual
    ) {
      continue;
    }
    await fs.writeFile(
      path.join(dir, ".provenance.json"),
      JSON.stringify({ ...prov, tamper: { at: now, expected, actual } }, null, 2),
      "utf-8",
    );
    await canaryOff(name, { reason: "tamper", now }, trailOpts);
    await appendImpactEntry(
      {
        source: "evolution",
        action: "canary-off",
        skillName: name,
        verdict: "rolled-back",
        detail: `live SKILL.md no longer matches the author's content hash (${expected.slice(0, 12)}); withheld from every run`,
        contentHash: expected,
        timestamp: now,
      },
      trailOpts,
    );
    result.tampered.push(name);
  }
  return result;
}
