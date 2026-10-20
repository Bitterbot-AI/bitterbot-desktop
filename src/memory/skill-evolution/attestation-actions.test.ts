import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCanaryExposure,
  readCanaryRegistry,
  resetCanaryRegistryCacheForTest,
} from "../../agents/skills/canary-registry.js";
import { readProvenance } from "../../agents/skills/impact-trail.js";
import { liveSkillPath, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { generateKeyPair, pubkeyId } from "../../commerce/envelope.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { applyAttestationDemotions } from "./attestation-actions.js";
import {
  ATTEST_PROTOCOL,
  signAttestation,
  skillContentSha256,
  storeAttestation,
} from "./attestation.js";
import { makeAttesterWeight } from "./attester-weight.js";

const PROMPT = [
  "<available_skills>",
  "  <skill>",
  "    <name>peer-skill</name>",
  "    <description>d</description>",
  "    <location>/x/skills/peer-skill/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

describe("PLAN-45 4.3: attestations become actionable (D-4)", () => {
  let tmp: string;
  let db: DatabaseSync;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "att-actions-"));
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "embedding_cache", ftsTable: "chunks_fts" });
    resetCanaryRegistryCacheForTest();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    resetCanaryRegistryCacheForTest();
  });

  it("canary-offs a live peer skill on two trusted regressions: withheld from every run, files kept, trail entry, idempotent", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const content =
      "---\nname: peer-skill\ndescription: Use when the task says peer; not otherwise.\n---\nbody\n";
    await fs.mkdir(path.dirname(liveSkillPath(roots, "peer-skill")), { recursive: true });
    await fs.writeFile(liveSkillPath(roots, "peer-skill"), content);
    await fs.writeFile(
      path.join(path.dirname(liveSkillPath(roots, "peer-skill")), ".provenance.json"),
      JSON.stringify({ author_pubkey: "PK", content_hash: skillContentSha256(content) }),
    );
    // A local (non-peer) skill is never touched.
    await fs.mkdir(path.dirname(liveSkillPath(roots, "local-skill")), { recursive: true });
    await fs.writeFile(
      liveSkillPath(roots, "local-skill"),
      "---\nname: local-skill\ndescription: d\n---\nx\n",
    );
    const own = generateKeyPair();
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sha = skillContentSha256(content);
    for (const key of [a, b]) {
      storeAttestation(
        db,
        signAttestation(
          {
            protocol: ATTEST_PROTOCOL,
            content_sha256: sha,
            corpus_version: "canonical-g5-s3",
            corpus_seed: 3,
            private_suite_sha256: null,
            verdict: "regression",
            wins: 0,
            losses: 4,
            ties: 0,
            p_value: 0.02,
            regressions: 1,
            trials_per_task: 1,
            model: null,
            attested_at: Date.now(),
            node_pubkey: null,
          },
          key,
        ),
        "peer",
      );
    }
    const weightOf = makeAttesterWeight({
      ownAttesterPubkey: pubkeyId(own),
      trustedAttesters: [pubkeyId(a), pubkeyId(b)],
    });
    const r = await applyAttestationDemotions({
      db,
      weightOf,
      ownAttesterPubkey: pubkeyId(own),
      storeOpts: { configDir: tmp },
    });
    expect(r).toEqual({ examined: 1, demoted: ["peer-skill"] });
    const registry = await readCanaryRegistry({ configDir: tmp });
    expect(registry.skills["peer-skill"]).toMatchObject({
      bucketFraction: 0,
      reason: "attestation",
    });
    // Withheld from every run, files kept.
    for (const run of ["r1", "r2", "r3"]) {
      expect(
        applyCanaryExposure({ prompt: PROMPT, runId: run, storeOpts: { configDir: tmp } }),
      ).not.toContain("peer-skill");
    }
    expect(await fs.readFile(liveSkillPath(roots, "peer-skill"), "utf-8")).toBe(content);
    const trail = await readProvenance({ configDir: tmp });
    expect(trail.at(-1)).toMatchObject({
      action: "canary-off",
      skillName: "peer-skill",
      verdict: "rolled-back",
    });
    // Idempotent.
    const again = await applyAttestationDemotions({
      db,
      weightOf,
      ownAttesterPubkey: pubkeyId(own),
      storeOpts: { configDir: tmp },
    });
    expect(again.demoted).toEqual([]);
    expect((await readProvenance({ configDir: tmp })).length).toBe(trail.length);
  });
});
