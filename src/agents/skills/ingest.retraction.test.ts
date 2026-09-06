/**
 * PLAN-45 Phase 3.4: a signed retraction stub (same publish verb, same key)
 * removes the quarantined / live copies of the version it names, is never
 * stored as a skill, and blocks a republish of the same bytes by the same
 * key. Author binding: another key's stub cannot retract it.
 */

import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { buildRetractionStub } from "../../memory/skill-evolution/provenance-trailer.js";
import { CONFIG_DIR } from "../../utils.js";
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
  peerId = "12D3KooWRetractPeer",
): SkillEnvelope {
  const skillBytes = Buffer.from(content, "utf-8");
  return {
    version: 1,
    skill_md: skillBytes.toString("base64"),
    name,
    author_peer_id: peerId,
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, skillBytes, pair.privateKey).toString("base64"),
    timestamp: Date.now(),
    content_hash: createHash("sha256").update(skillBytes).digest("hex"),
  };
}

function configFor(tmpRoot: string): BitterbotConfig {
  return {
    skills: {
      p2p: { ingestPolicy: "review", quarantineDir: path.join(tmpRoot, "skills-incoming") },
    },
  } as unknown as BitterbotConfig;
}

// Unique per-run names: the live root is CONFIG_DIR/skills (shared).
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const LIVE_NAME = `retract-live-${RUN_TAG}`;
const Q_NAME = `retract-q-${RUN_TAG}`;

// Distinct bytes per case: ingest dedups on content hash process-wide.
const skillMd = (name: string, variant = "") =>
  `---\nname: ${name}\ndescription: Use when curl times out against a flaky host; not for local files.\n---\n\nAlways pass --max-time. ${variant}\n`;

describe("ingestSkill: signed retractions (PLAN-45 Phase 3.4)", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-retract-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    for (const dir of [
      path.join(CONFIG_DIR, "skills", LIVE_NAME),
      path.join(CONFIG_DIR, "skills-archive", LIVE_NAME),
    ]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("removes the quarantined copy, is never stored, and blocks a republish of the same bytes by the same key", async () => {
    const pair = generateEd25519();
    const original = buildEnvelope(skillMd(Q_NAME), Q_NAME, pair);
    const first = await ingestSkill({ envelope: original, config: configFor(tmpRoot) });
    expect(first.action).toBe("quarantined");
    const qDir = path.join(tmpRoot, "skills-incoming", Q_NAME);
    await expect(fs.access(qDir)).resolves.toBeUndefined();

    const stub = buildRetractionStub({
      origin: "wiki-evolution",
      name: Q_NAME,
      contentSha256: original.content_hash,
      reason: "production regression",
      retractedAt: new Date().toISOString(),
    });
    const res = await ingestSkill({
      envelope: buildEnvelope(stub, Q_NAME, pair),
      config: configFor(tmpRoot),
    });
    expect(res).toMatchObject({ ok: true, action: "retracted", skillName: Q_NAME });
    expect(res.reason).toContain(`quarantine:${Q_NAME}`);
    await expect(fs.access(qDir)).rejects.toThrow();
    // The stub itself never became a quarantined skill.
    const entries = await fs.readdir(path.join(tmpRoot, "skills-incoming")).catch(() => []);
    expect(entries).not.toContain(Q_NAME);

    // Republishing the retracted bytes (fresh envelope, same key) is refused
    // before any review.
    const again = await ingestSkill({
      envelope: buildEnvelope(skillMd(Q_NAME), Q_NAME, pair, "12D3KooWAnotherPeerId"),
      config: configFor(tmpRoot),
    });
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("retracted by its author");
  });

  it("author binding: a stub signed by another key does not touch the copy", async () => {
    const author = generateEd25519();
    const impostor = generateEd25519();
    const original = buildEnvelope(skillMd(Q_NAME, "binding"), Q_NAME, author);
    expect((await ingestSkill({ envelope: original, config: configFor(tmpRoot) })).action).toBe(
      "quarantined",
    );
    const stub = buildRetractionStub({
      origin: "wiki-evolution",
      name: Q_NAME,
      contentSha256: original.content_hash,
      reason: "not mine",
      retractedAt: new Date().toISOString(),
    });
    const res = await ingestSkill({
      envelope: buildEnvelope(stub, Q_NAME, impostor, "12D3KooWImpostor"),
      config: configFor(tmpRoot),
    });
    expect(res.action).toBe("retracted");
    expect(res.reason).toBe("no local copy");
    await expect(fs.access(path.join(tmpRoot, "skills-incoming", Q_NAME))).resolves.toBeUndefined();
  });

  it("archives and removes a LIVE copy carrying the author's provenance", async () => {
    const pair = generateEd25519();
    const content = skillMd(LIVE_NAME);
    const hash = createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
    const liveDir = path.join(CONFIG_DIR, "skills", LIVE_NAME);
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(path.join(liveDir, "SKILL.md"), content, "utf-8");
    await fs.writeFile(
      path.join(liveDir, ".provenance.json"),
      JSON.stringify({ origin: "peer", author_pubkey: pair.pubkeyBase64, content_hash: hash }),
      "utf-8",
    );
    const stub = buildRetractionStub({
      origin: "wiki-evolution",
      name: LIVE_NAME,
      contentSha256: hash,
      reason: "rolled back upstream",
      retractedAt: new Date().toISOString(),
    });
    const res = await ingestSkill({
      envelope: buildEnvelope(stub, LIVE_NAME, pair),
      config: configFor(tmpRoot),
    });
    expect(res.action).toBe("retracted");
    expect(res.reason).toContain(`live:${LIVE_NAME}`);
    await expect(fs.access(path.join(liveDir, "SKILL.md"))).rejects.toThrow();
    const archived = await fs.readFile(
      path.join(CONFIG_DIR, "skills-archive", LIVE_NAME, "v1", "SKILL.md"),
      "utf-8",
    );
    expect(archived).toBe(content);
    const sidecars = JSON.parse(
      await fs.readFile(
        path.join(CONFIG_DIR, "skills-archive", LIVE_NAME, "v1", ".sidecars.json"),
        "utf-8",
      ),
    ) as { files: Record<string, string> };
    expect(sidecars.files[".provenance.json"]).toContain('"retracted"');
  });
});
