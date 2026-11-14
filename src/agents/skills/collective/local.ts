import { IdSchema, type SkillRelease } from "./contracts.js";
import { collectiveIdentity } from "./service.js";
import { signRelease } from "./signatures.js";
import type { CollectiveSkillStore } from "./store.js";

/** Local edits are new immutable releases in a stable lineage, never in-place writes. */
export function releaseLocalPackage(
  store: CollectiveSkillStore,
  hash: string,
  skillId: string,
): string {
  IdSchema.parse(skillId);
  const key = collectiveIdentity(),
    publisher = `ed25519:${key.publicKeyHex}`;
  const prior = store.db
    .prepare(
      "SELECT id,body FROM collective_releases WHERE lineage=? AND scope=? ORDER BY version DESC LIMIT 1",
    )
    .get(`${publisher}/${skillId}`, JSON.stringify({ kind: "private" })) as
    | { id: string; body: string }
    | undefined;
  const previous = prior ? (JSON.parse(prior.body) as SkillRelease) : null;
  if (previous?.packageHash === hash && store.release(prior!.id)) return prior!.id;
  return store.addRelease(
    signRelease(
      {
        protocol: "bitterbot/skill-release/1",
        publisher,
        skillId,
        version: (previous?.version ?? 0) + 1,
        previousRelease: prior?.id ?? null,
        parents: previous && previous.packageHash !== hash ? [previous.packageHash] : [],
        packageHash: hash,
        requirementsSummary: store.get(hash)!.manifest.requirements,
        scope: { kind: "private" },
        issuedAt: store.now(),
      },
      key,
    ),
  );
}
