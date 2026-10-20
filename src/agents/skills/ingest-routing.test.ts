/**
 * PLAN-44 Phase 3 (I8): a quarantined envelope never reaches the
 * skill-network bridge (where it became an `active`, recall-visible chunk);
 * only an accepted one does, and the operator's accept re-routes it from
 * the `.provenance.json` the accept wrote beside the live SKILL.md.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAcceptedEnvelope, shouldBridgeIngest } from "./ingest.js";

describe("shouldBridgeIngest", () => {
  it("routes accepted only — never quarantined, rejected, or a failed ingest", () => {
    expect(shouldBridgeIngest({ action: "accepted" })).toBe(true);
    expect(shouldBridgeIngest({ action: "quarantined" })).toBe(false);
    expect(shouldBridgeIngest({ action: "rejected" })).toBe(false);
    expect(shouldBridgeIngest(null)).toBe(false);
    expect(shouldBridgeIngest(undefined)).toBe(false);
  });
});

describe("readAcceptedEnvelope", () => {
  it("returns the provenance envelope beside an accepted SKILL.md, null when absent or malformed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-routing-"));
    try {
      const skillPath = path.join(dir, "SKILL.md");
      await fs.writeFile(skillPath, "---\nname: x\ndescription: y\n---\nbody\n");
      expect(await readAcceptedEnvelope(skillPath)).toBeNull();
      await fs.writeFile(path.join(dir, ".provenance.json"), "{not json");
      expect(await readAcceptedEnvelope(skillPath)).toBeNull();
      await fs.writeFile(
        path.join(dir, ".provenance.json"),
        JSON.stringify({ name: "x", content_hash: "abc", skill_md: "body", author_pubkey: "pk" }),
      );
      expect(await readAcceptedEnvelope(skillPath)).toMatchObject({
        content_hash: "abc",
        skill_md: "body",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("acceptIncomingSkill re-verifies the quarantined file against its envelope (adversarial L7)", () => {
  it("refuses when SKILL.md on disk no longer hashes to envelope.content_hash", async () => {
    const { createHash } = await import("node:crypto");
    const { acceptIncomingSkill } = await import("./ingest.js");
    const quarantineDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-q-"));
    try {
      const original = "---\nname: peer-skill\ndescription: y\n---\nbody\n";
      const dir = path.join(quarantineDir, "peer-skill");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, ".envelope.json"),
        JSON.stringify({
          name: "peer-skill",
          content_hash: createHash("sha256").update(Buffer.from(original, "utf-8")).digest("hex"),
          skill_md: Buffer.from(original).toString("base64"),
          author_pubkey: "pk",
        }),
      );
      await fs.writeFile(path.join(dir, "SKILL.md"), original.replace("body", "tampered body"));
      const result = await acceptIncomingSkill({
        skillName: "peer-skill",
        config: { skills: { p2p: { quarantineDir } } } as never,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no longer matches its envelope content hash/);
      // Still in quarantine, untouched.
      await fs.access(path.join(dir, "SKILL.md"));
    } finally {
      await fs.rm(quarantineDir, { recursive: true, force: true });
    }
  });
});
