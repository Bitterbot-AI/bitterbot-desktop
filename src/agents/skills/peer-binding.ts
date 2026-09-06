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
import { parseSkillMarkdown } from "../../memory/skill-curator-judge.js";
import { hashProposalContent } from "../../memory/skill-evolution/proposal-apply.js";
import { canaryOff, isCanaryOff, readCanaryRegistry } from "./canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "./impact-trail.js";
import { resolveStorageRoots } from "./skill-storage.js";

export interface PeerBindingCheck {
  examined: number;
  tampered: string[];
  /** Pre-4.4 routing-repaired skills re-bound to their repaired body. */
  rebound: string[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

/** The routing-repair stamp's body hash (routing-repair.ts `bodyHash`): the markdown body without frontmatter. */
export function repairBodyHash(skillMd: string): string {
  const parsed = parseSkillMarkdown(skillMd);
  return hashProposalContent(parsed?.body ?? skillMd);
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
    return { examined: 0, tampered: [], rebound: [] };
  }
  const result: PeerBindingCheck = { examined: 0, tampered: [], rebound: [] };
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
    // A routing repair made before PLAN-45 4.4 rewrote the body and left
    // the author's original hash on the provenance. The repair stamp
    // carries its own hash of the repaired body: when it matches, this is
    // the node's own edit, not a tamper; re-bind and move on (one-time
    // migration of the pre-4.4 state).
    const rewrite = prov.routing_rewrite as { bodyHash?: unknown } | undefined;
    if (actual !== expected && rewrite && rewrite.bodyHash === repairBodyHash(body)) {
      await fs.writeFile(
        path.join(dir, ".provenance.json"),
        JSON.stringify(
          {
            ...prov,
            original_content_hash: prov.original_content_hash ?? expected,
            content_hash: actual,
          },
          null,
          2,
        ),
        "utf-8",
      );
      result.rebound.push(name);
      continue;
    }
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
