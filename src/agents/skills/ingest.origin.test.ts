/**
 * Origin classification + self-loopback guard for the skill ingest path.
 *
 * Regression coverage for the "31 received skills from unknown peer" incident:
 * locally-generated / locally-harvested skills were landing in the peer
 * quarantine and rendering as anonymous inbound peers. listIncomingSkills must
 * now tag each entry with a truthful origin, and ingestSkill must drop a
 * crystal this node itself published when it loops back over gossip.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { ingestSkill, listIncomingSkills, type SkillEnvelope } from "./ingest.js";

type Pair = { pubkeyBase64: string; privateKey: KeyObject };

function generateEd25519(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { pubkeyBase64: spki.subarray(-32).toString("base64"), privateKey };
}

function buildEnvelope(
  content: string,
  name: string,
  pair: Pair,
  over: Partial<SkillEnvelope> = {},
): SkillEnvelope {
  const skillBytes = Buffer.from(content, "utf-8");
  return {
    version: 1,
    skill_md: skillBytes.toString("base64"),
    name,
    author_peer_id: "12D3KooWForeignPeer",
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, skillBytes, pair.privateKey).toString("base64"),
    timestamp: Date.now(),
    content_hash: createHash("sha256").update(skillBytes).digest("hex"),
    ...over,
  };
}

const SKILL = (desc: string, extra = "") =>
  `---\nname: s\ndescription: ${desc}\n${extra}---\n\nbody\n`;

describe("listIncomingSkills — origin classification", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-origin-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeEntry(name: string, envelope: SkillEnvelope | null, skillMd?: string) {
    const d = path.join(dir, name);
    await fs.mkdir(d, { recursive: true });
    if (envelope) await fs.writeFile(path.join(d, ".envelope.json"), JSON.stringify(envelope));
    if (skillMd) await fs.writeFile(path.join(d, "SKILL.md"), skillMd);
  }

  it("tags peer, external-scrape, local-dream, and incomplete correctly", async () => {
    const pair = generateEd25519();
    // genuine peer: foreign peer id, no origin field (older envelope)
    await writeEntry("peer1", buildEnvelope(SKILL("A real peer skill."), "peer1", pair));
    // external-scrape by back-compat synthetic peer id
    await writeEntry(
      "scrape-legacy",
      buildEnvelope(SKILL("Harvest."), "scrape-legacy", pair, {
        author_peer_id: "local-skill-seekers",
      }),
    );
    // external-scrape by explicit origin stamp (post-fix envelope)
    await writeEntry(
      "scrape-stamped",
      buildEnvelope(SKILL("Harvest."), "scrape-stamped", pair, {
        origin: "external-scrape",
      } as Partial<SkillEnvelope>),
    );
    // local dream crystal: placeholder description
    await writeEntry(
      "dream1",
      buildEnvelope(SKILL("Dream-generated skill crystal"), "dream1", pair),
    );
    // incomplete: SKILL.md present, envelope missing (interrupted write)
    await writeEntry("broken1", null, SKILL("Half-written."));

    const cfg: BitterbotConfig = {
      skills: { p2p: { quarantineDir: dir } },
    } as unknown as BitterbotConfig;
    const items = await listIncomingSkills(cfg);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.origin]));

    expect(byName["peer1"]).toBe("peer");
    expect(byName["scrape-legacy"]).toBe("external-scrape");
    expect(byName["scrape-stamped"]).toBe("external-scrape");
    expect(byName["dream1"]).toBe("local-dream");
    expect(byName["broken1"]).toBe("incomplete");
  });
});

describe("ingestSkill — self-loopback guard", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-loop-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("drops a peer skill whose author is our own publish key, writing nothing", async () => {
    const me = generateEd25519();
    const envelope = buildEnvelope(SKILL("Something we published."), "mine", me);
    const cfg: BitterbotConfig = {
      skills: { p2p: { ingestPolicy: "review", quarantineDir: dir } },
    } as unknown as BitterbotConfig;

    const result = await ingestSkill({
      envelope,
      config: cfg,
      ownPublishPubkey: me.pubkeyBase64,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/self-loopback/);
    // Nothing landed in the quarantine dir.
    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(0);
  });

  it("still ingests a genuine foreign peer skill (loopback guard is specific)", async () => {
    const me = generateEd25519();
    const them = generateEd25519();
    const envelope = buildEnvelope(SKILL("A peer's skill."), "theirs", them);
    const cfg: BitterbotConfig = {
      skills: { p2p: { ingestPolicy: "review", quarantineDir: dir } },
    } as unknown as BitterbotConfig;

    const result = await ingestSkill({
      envelope,
      config: cfg,
      ownPublishPubkey: me.pubkeyBase64,
    });

    // Under review policy an untrusted peer is quarantined (not rejected as loopback).
    expect(result.action).toBe("quarantined");
    const entries = await fs.readdir(dir);
    expect(entries).toContain("theirs");
  });
});
