/**
 * PLAN-45 4.2 / 4.4: an accept admits a peer skill to the local gate
 * (staging, never live); acceptance binds to the content hash and the
 * author key; a signed trailer must belong to its envelope.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { generateKeyPair } from "../../commerce/envelope.js";
import { buildProvenanceTrailer } from "../../memory/skill-evolution/provenance-trailer.js";
import { CONFIG_DIR } from "../../utils.js";
import { acceptIncomingSkill, ingestSkill, nameCollision, type SkillEnvelope } from "./ingest.js";
import { readStaged, resolveStorageRoots, stagingSkillDir } from "./skill-storage.js";

function generateEd25519(): { pubkeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { pubkeyBase64: spki.subarray(-32).toString("base64"), privateKey };
}
function envelopeFor(
  content: string,
  name: string,
  pair: { pubkeyBase64: string; privateKey: KeyObject },
  timestamp = Date.now(),
): SkillEnvelope {
  const bytes = Buffer.from(content, "utf-8");
  return {
    version: 1,
    skill_md: bytes.toString("base64"),
    name,
    author_peer_id: "12D3KooWVersionBound",
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, bytes, pair.privateKey).toString("base64"),
    timestamp,
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const NAME = `vb-skill-${RUN_TAG}`;
const md = (name: string, v: string) =>
  `---\nname: ${name}\ndescription: Use when the task asks to ${name} against a flaky host; not for local files.\n---\n\nversion ${v}\n`;

describe("version-bound trust and the receiver re-gate", () => {
  let tmp: string;
  const cfg = (): BitterbotConfig =>
    ({
      skills: { p2p: { ingestPolicy: "review", quarantineDir: path.join(tmp, "skills-incoming") } },
    }) as unknown as BitterbotConfig;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-vb-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    for (const dir of [
      path.join(CONFIG_DIR, "skills", NAME),
      path.join(CONFIG_DIR, "skills-staging", NAME),
      path.join(CONFIG_DIR, "skills-archive", NAME),
    ]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("nameCollision: another author's key cannot take a bound name; the same author may only move forward", async () => {
    const author = generateEd25519();
    const other = generateEd25519();
    const liveRoot = path.join(tmp, "skills");
    const quarantineDir = path.join(tmp, "skills-incoming");
    const dir = path.join(liveRoot, "bound");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), md("bound", "1"));
    await fs.writeFile(
      path.join(dir, ".provenance.json"),
      JSON.stringify({ author_pubkey: author.pubkeyBase64, content_hash: "x", timestamp: 1000 }),
    );
    const v2 = envelopeFor(md("bound", "2"), "bound", author, 2000);
    expect(
      await nameCollision({ name: "bound", envelope: v2, liveRoot, quarantineDir }),
    ).toBeNull();
    const squat = envelopeFor(md("bound", "2"), "bound", other, 2000);
    expect(
      await nameCollision({ name: "bound", envelope: squat, liveRoot, quarantineDir }),
    ).toContain("another author");
    const downgrade = envelopeFor(md("bound", "0"), "bound", author, 500);
    expect(
      await nameCollision({ name: "bound", envelope: downgrade, liveRoot, quarantineDir }),
    ).toContain("downgrade");
    // A local skill's name is never taken by a peer.
    const localDir = path.join(liveRoot, "mine");
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(path.join(localDir, "SKILL.md"), md("mine", "1"));
    expect(await nameCollision({ name: "mine", envelope: v2, liveRoot, quarantineDir })).toContain(
      "local skill",
    );
    // A pending review entry from another author blocks; the same author's newer version may replace it.
    const pending = path.join(quarantineDir, "queued");
    await fs.mkdir(pending, { recursive: true });
    await fs.writeFile(
      path.join(pending, ".envelope.json"),
      JSON.stringify({ author_pubkey: other.pubkeyBase64, content_hash: "h1", timestamp: 3000 }),
    );
    expect(
      await nameCollision({ name: "queued", envelope: v2, liveRoot, quarantineDir }),
    ).toContain("under review from another author");
    const otherNewer = envelopeFor(md("queued", "3"), "queued", other, 4000);
    expect(
      await nameCollision({ name: "queued", envelope: otherNewer, liveRoot, quarantineDir }),
    ).toBeNull();
  });

  it("a signed trailer lifted onto another body or another node key is a REJECT", async () => {
    const node = generateEd25519();
    const device = generateKeyPair();
    const body = md(NAME, "1");
    const trailer = buildProvenanceTrailer(
      {
        origin: "wiki-evolution",
        validation: {
          mode: "tasks",
          verdict: "accepted",
          validatedAt: Date.now(),
          model: "openai/gpt-x",
        },
      },
      { skillName: NAME, body, key: device, nodePubkey: node.pubkeyBase64 },
    );
    // Lifted onto a different body.
    const lifted = `${md(NAME, "2").replace(/\n+$/, "")}\n${trailer}`;
    const r1 = await ingestSkill({ envelope: envelopeFor(lifted, NAME, node), config: cfg() });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("does not match the SKILL.md body");
    // Right body, sent by a different node key.
    const impostor = generateEd25519();
    const bound = `${body.replace(/\n+$/, "")}\n${trailer}`;
    const r2 = await ingestSkill({ envelope: envelopeFor(bound, NAME, impostor), config: cfg() });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("different node key");
    // Right body, right node: quarantined for review with the claim intact.
    const r3 = await ingestSkill({ envelope: envelopeFor(bound, NAME, node), config: cfg() });
    expect(r3.action).toBe("quarantined");
    const env = JSON.parse(
      await fs.readFile(path.join(tmp, "skills-incoming", NAME, ".envelope.json"), "utf-8"),
    ) as { evolution_provenance?: { binding?: { attesterPubkey: string } } };
    expect(env.evolution_provenance?.binding?.attesterPubkey).toBe(
      `ed25519:${device.publicKeyHex}`,
    );
  });

  it("an operator accept lands in staging with origin peer and the envelope as provenance, never live; the auto policy does the same", async () => {
    const node = generateEd25519();
    const body = md(NAME, "1");
    const q = await ingestSkill({ envelope: envelopeFor(body, NAME, node), config: cfg() });
    expect(q.action).toBe("quarantined");
    const accepted = await acceptIncomingSkill({ skillName: NAME, config: cfg() });
    expect(accepted).toMatchObject({ ok: true, action: "staged", skillName: NAME });
    const roots = resolveStorageRoots();
    const staged = await readStaged(roots, NAME);
    expect(staged?.content).toBe(body);
    expect(staged?.meta.gateStatus).toBe("passed");
    expect(staged?.meta.author).toBe("peer");
    const meta = JSON.parse(
      await fs.readFile(path.join(stagingSkillDir(roots, NAME), ".evolution-meta.json"), "utf-8"),
    ) as {
      origin: string;
      peer?: { authorPubkey: string; contentHash: string };
      ladder?: { state: string };
    };
    expect(meta.origin).toBe("peer");
    expect(meta.peer?.authorPubkey).toBe(node.pubkeyBase64);
    expect(meta.ladder?.state).toBe("staged");
    const prov = JSON.parse(
      await fs.readFile(path.join(stagingSkillDir(roots, NAME), ".provenance.json"), "utf-8"),
    ) as { skill_md?: string; accepted_by?: string };
    expect(typeof prov.skill_md).toBe("string");
    expect(prov.accepted_by).toBe("operator");
    await expect(fs.access(path.join(CONFIG_DIR, "skills", NAME, "SKILL.md"))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, "skills-incoming", NAME))).rejects.toThrow();
    // Auto policy + trusted key: skips REVIEW, not the gate.
    await fs.rm(stagingSkillDir(roots, NAME), { recursive: true, force: true });
    const node2 = generateEd25519();
    const auto = await ingestSkill({
      envelope: envelopeFor(md(NAME, "auto"), NAME, node2),
      config: {
        skills: {
          p2p: {
            ingestPolicy: "auto",
            trustList: [node2.pubkeyBase64],
            quarantineDir: path.join(tmp, "skills-incoming"),
          },
        },
      } as unknown as BitterbotConfig,
    });
    expect(auto.action).toBe("staged");
    await expect(fs.access(path.join(CONFIG_DIR, "skills", NAME, "SKILL.md"))).rejects.toThrow();
    expect((await readStaged(roots, NAME))?.content).toBe(md(NAME, "auto"));
  });
});
