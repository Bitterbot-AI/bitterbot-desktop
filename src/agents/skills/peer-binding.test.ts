import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCanaryRegistry, resetCanaryRegistryCacheForTest } from "./canary-registry.js";
import { readProvenance } from "./impact-trail.js";
import { sha256Hex, verifyPeerBindings } from "./peer-binding.js";
import { liveSkillPath, resolveStorageRoots } from "./skill-storage.js";

describe("PLAN-45 4.4: live peer bytes stay bound to the signed hash", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "peer-binding-"));
    resetCanaryRegistryCacheForTest();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("canary-offs a peer skill whose SKILL.md no longer hashes to its provenance; intact and non-peer skills untouched", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const good = "---\nname: intact\ndescription: d\n---\nbody\n";
    const bad = "---\nname: edited\ndescription: d\n---\nbody\n";
    for (const [name, content, hash] of [
      ["intact", good, sha256Hex(good)],
      ["edited", bad, sha256Hex("something else")],
    ] as const) {
      const dir = path.dirname(liveSkillPath(roots, name));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(liveSkillPath(roots, name), content);
      await fs.writeFile(
        path.join(dir, ".provenance.json"),
        JSON.stringify({ author_pubkey: "PK", content_hash: hash }),
      );
    }
    const dir = path.dirname(liveSkillPath(roots, "local"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(liveSkillPath(roots, "local"), "---\nname: local\ndescription: d\n---\nx\n");
    const r = await verifyPeerBindings({ configDir: tmp });
    expect(r).toEqual({ examined: 2, tampered: ["edited"] });
    const registry = await readCanaryRegistry({ configDir: tmp });
    expect(registry.skills.edited).toMatchObject({ bucketFraction: 0, reason: "tamper" });
    expect(registry.skills.intact).toBeUndefined();
    expect((await readProvenance({ configDir: tmp })).at(-1)).toMatchObject({
      action: "canary-off",
      skillName: "edited",
    });
    // Second pass: already withheld, no second entry.
    expect((await verifyPeerBindings({ configDir: tmp })).tampered).toEqual([]);
  });
});
