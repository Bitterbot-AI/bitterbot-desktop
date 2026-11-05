import { createHash, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ingestSkill, acceptIncomingSkill, permitsCrystalImport } from "../agents/skills/ingest.js";
import { STRATEGY_PACKET_MARKER } from "./learning-strategy-peer.js";
import { SkillNetworkBridge } from "./skill-network-bridge.js";

it("keeps signed strategy packets quarantined even with trust or manual acceptance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strategy-route-")),
    db = new DatabaseSync(":memory:");
  try {
    const key = generateKeyPairSync("ed25519"),
      name = `strategy-${randomUUID()}`;
    const bytes = Buffer.from(
      `---\nname: ${name}\ndescription: research candidate\n---\n<!-- ${STRATEGY_PACKET_MARKER}:e30= -->\n`,
    );
    const envelope = {
      version: 1,
      name,
      skill_md: bytes.toString("base64"),
      content_hash: createHash("sha256").update(bytes).digest("hex"),
      timestamp: Date.now(),
      author_peer_id: "test",
      author_pubkey: key.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64"),
      signature: sign(null, bytes, key.privateKey).toString("base64"),
    };
    const config = {
      skills: {
        p2p: {
          ingestPolicy: "auto" as const,
          trustList: [envelope.author_pubkey],
          quarantineDir: directory,
          injectionScanner: "off" as const,
        },
      },
    };
    const ingested = await ingestSkill({ envelope, config, notifyQuarantine: () => {} });
    expect(ingested).toMatchObject({ ok: true, action: "quarantined", proceduralCandidate: true });
    expect(permitsCrystalImport(ingested)).toBe(false);
    expect(await acceptIncomingSkill({ skillName: ingested.skillName!, config })).toMatchObject({
      ok: false,
      action: "rejected",
    });
    const bridge = new SkillNetworkBridge(db, null);
    expect(bridge.ingestNetworkSkill(envelope)).toMatchObject({
      ok: false,
      action: "rejected",
      reason: "learning strategies require host shadow import",
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
