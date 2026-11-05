import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { ingestSkill, permitsCrystalImport, type SkillEnvelope } from "../agents/skills/ingest.js";
import { learningHash } from "./procedural-learning-contract.js";
import { LEARNING_PACKET_MARKER } from "./procedural-learning-peer.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";
import { SkillNetworkBridge } from "./skill-network-bridge.js";

function signedPacket(): SkillEnvelope {
  const scope = {
    tool: "fixture",
    version: "1",
    operation: "read",
    contractHash: learningHash("contract"),
  };
  const candidate = {
    schemaVersion: 1,
    scope,
    lesson: "Read the typed result",
    adapter: "fixture-v1",
    program: "read",
    counterexamples: ["Do not use with v2"],
    parents: [],
    sourceEpisodes: ["source-unique"],
    origin: "experience",
    sharing: "shareable",
    expiresAt: Date.now() + 86400000,
  };
  const payload = Buffer.from(
    JSON.stringify({ candidate, hash: learningHash(candidate) }),
  ).toString("base64");
  const bytes = Buffer.from(
    `---\nname: learning-route-fixture\ndescription: A quarantined procedure\n---\n<!-- ${LEARNING_PACKET_MARKER}:${payload} -->\n`,
  );
  const keys = generateKeyPairSync("ed25519");
  return {
    version: 1,
    name: "learning-route-fixture",
    skill_md: bytes.toString("base64"),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    timestamp: Date.now(),
    author_peer_id: "test-peer",
    author_pubkey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
  };
}
it("keeps even a trusted signed package out of the ordinary filesystem skill loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-ingest-"));
  try {
    const envelope = signedPacket();
    const result = await ingestSkill({
      envelope,
      config: {
        skills: {
          p2p: {
            ingestPolicy: "auto",
            trustList: [envelope.author_pubkey],
            quarantineDir: dir,
            injectionScanner: "off",
          },
        },
      },
      notifyQuarantine: () => {},
    });
    expect(result).toMatchObject({ ok: true, action: "quarantined", proceduralCandidate: true });
    expect(permitsCrystalImport(result)).toBe(false);
    expect(result.skillPath?.startsWith(dir)).toBe(true);
    expect(readFileSync(result.skillPath!, "utf8")).toContain(LEARNING_PACKET_MARKER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("routes native packets into quarantine without crystal insertion or shadow publication", async () => {
  const db = new DatabaseSync(":memory:");
  const memory = new DatabaseSync(":memory:");
  try {
    const publishSkill = vi.fn();
    const bridge = new SkillNetworkBridge(db, { publishSkill });
    const service = new ProceduralLearning(new ProceduralLearningStore(memory));
    bridge.setProceduralLearning(() => service);
    expect(bridge.ingestNetworkSkill(signedPacket())).toMatchObject({
      ok: false,
      action: "rejected",
      reason: "procedural candidate quarantined; no crystal activation",
    });
    // No chunks table exists: a mistaken ordinary import would throw or fail this expectation.
    expect(memory.prepare("SELECT state FROM learning_entries").get()).toMatchObject({
      state: "candidate",
    });
    expect(service.store.costs().unknownAcquisitions).toBe(1);
    await expect(bridge.publishLearningCandidate(learningHash("unknown"))).rejects.toThrow(
      "disabled",
    );
    expect(publishSkill).not.toHaveBeenCalled();
  } finally {
    db.close();
    memory.close();
  }
});
