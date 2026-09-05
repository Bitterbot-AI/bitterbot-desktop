/**
 * PLAN-44 Phase 5b: the description contract and the overlap check at P2P
 * ingest. A peer skill the receiving agent could never route (its
 * description fails the contract) is held for review with the reason on
 * the envelope, even from a trusted publisher under auto policy.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { ingestSkill, listIncomingSkills, type SkillEnvelope } from "./ingest.js";

type Pair = { publicKey: KeyObject; privateKey: KeyObject; pubkeyBase64: string };
function generateEd25519(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { publicKey, privateKey, pubkeyBase64: spki.subarray(-32).toString("base64") };
}
function buildEnvelope(content: string, name: string, pair: Pair): SkillEnvelope {
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

describe("ingestSkill — routing hold (PLAN-44 Phase 5b)", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-ingest-routing-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("holds a trusted peer's skill under auto policy when its description cannot route, recording the reason", async () => {
    const pair = generateEd25519();
    const config: BitterbotConfig = {
      skills: {
        p2p: {
          ingestPolicy: "auto",
          trustList: [pair.pubkeyBase64],
          quarantineDir: path.join(tmpRoot, "skills-incoming"),
        },
      },
    } as BitterbotConfig;
    const envelope = buildEnvelope(
      "---\nname: peer-tagline\ndescription: A collective list of free APIs\n---\n# body\nsome rule here\n",
      "peer-tagline",
      pair,
    );
    const result = await ingestSkill({ envelope, config, workspaceDir: tmpRoot });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("quarantined");
    const written = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, "skills-incoming", "peer-tagline", ".envelope.json"),
        "utf-8",
      ),
    ) as { routing_hold?: boolean; routing?: { contractIssues: string[] } };
    expect(written.routing_hold).toBe(true);
    expect(written.routing?.contractIssues).toEqual(
      expect.arrayContaining(["too-short", "no-trigger-clause", "no-scope-out-clause"]),
    );
    const listed = await listIncomingSkills(config);
    expect(listed[0]?.routing?.hold).toBe(true);
    expect(listed[0]?.routing?.summary).toContain("description contract");
  });

  it("records a clean assessment (no hold) for a compliant description", async () => {
    const pair = generateEd25519();
    const config: BitterbotConfig = {
      skills: {
        p2p: { ingestPolicy: "review", quarantineDir: path.join(tmpRoot, "skills-incoming") },
      },
    } as BitterbotConfig;
    const envelope = buildEnvelope(
      "---\nname: peer-curl-guard\ndescription: Bound curl in exec with --max-time when the task runs curl; not for commands without network calls.\n---\n# body\nsome rule here\n",
      "peer-curl-guard",
      pair,
    );
    const result = await ingestSkill({ envelope, config, workspaceDir: tmpRoot });
    expect(result.action).toBe("quarantined"); // review policy
    const written = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, "skills-incoming", "peer-curl-guard", ".envelope.json"),
        "utf-8",
      ),
    ) as { routing_hold?: boolean; routing?: { contractIssues: string[]; overlap: unknown } };
    expect(written.routing_hold).toBe(false);
    expect(written.routing?.contractIssues).toEqual([]);
  });
});
