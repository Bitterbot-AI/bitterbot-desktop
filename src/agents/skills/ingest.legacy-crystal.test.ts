/**
 * PLAN-42: unvalidated legacy dream crystals are auto-rejected at ingest,
 * while skills carrying wiki-evolution validation evidence still quarantine
 * for local review.
 */

import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { ingestSkill, type SkillEnvelope } from "./ingest.js";

function generateEd25519(): { pubkeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { pubkeyBase64: spki.subarray(-32).toString("base64"), privateKey };
}

function buildEnvelope(
  content: string,
  name: string,
  pair: { pubkeyBase64: string; privateKey: KeyObject },
): SkillEnvelope {
  const skillBytes = Buffer.from(content, "utf-8");
  return {
    version: 1,
    skill_md: skillBytes.toString("base64"),
    name,
    author_peer_id: "12D3KooWTestPeer",
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, skillBytes, pair.privateKey).toString("base64"),
    timestamp: Date.now(),
    content_hash: createHash("sha256").update(skillBytes).digest("hex"),
  };
}

function configFor(tmpRoot: string, overrides: Record<string, unknown> = {}): BitterbotConfig {
  return {
    skills: {
      p2p: {
        ingestPolicy: "review",
        quarantineDir: path.join(tmpRoot, "skills-incoming"),
        ...overrides,
      },
    },
  } as unknown as BitterbotConfig;
}

const LEGACY_CRYSTAL = `---
name: some-uuid
description: Dream-generated skill crystal
---

Do a thing.`;

const VALIDATED_SKILL = `---
name: curl-timeout-guard
description: Dream-generated skill crystal
---

Always pass --max-time.

<!-- wiki-evolution-provenance {"verdict":"accepted","mode":"records"} -->`;

describe("ingestSkill — legacy dream crystal rejection (PLAN-42)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-legacy-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects an unvalidated dream crystal at the door", async () => {
    const pair = generateEd25519();
    const res = await ingestSkill({
      envelope: buildEnvelope(LEGACY_CRYSTAL, "some-uuid", pair),
      config: configFor(tmpRoot),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("legacy unvalidated dream crystal");
    // Nothing written to quarantine.
    await expect(fs.readdir(path.join(tmpRoot, "skills-incoming"))).rejects.toThrow();
  });

  it("still quarantines a crystal that carries validation evidence", async () => {
    const pair = generateEd25519();
    const res = await ingestSkill({
      envelope: buildEnvelope(VALIDATED_SKILL, "curl-timeout-guard", pair),
      config: configFor(tmpRoot),
    });
    expect(res.action).toBe("quarantined");
    const entries = await fs.readdir(path.join(tmpRoot, "skills-incoming"));
    expect(entries).toContain("curl-timeout-guard");
  });

  it("honors the kill switch (rejectLegacyCrystals=false)", async () => {
    const pair = generateEd25519();
    const res = await ingestSkill({
      envelope: buildEnvelope(LEGACY_CRYSTAL, "some-uuid", pair),
      config: configFor(tmpRoot, { rejectLegacyCrystals: false }),
    });
    expect(res.action).toBe("quarantined");
  });
});
