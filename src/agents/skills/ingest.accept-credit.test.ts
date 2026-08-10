/**
 * Audit 2026-08-09 F6: manual accept/reject of a quarantined peer skill must
 * credit/debit that peer's reputation, or graduated trust is a dead end
 * (every peer skill goes to review, accept records nothing, skills_accepted
 * stays 0 forever, no peer ever auto-accepts).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { CONFIG_DIR } from "../../utils.js";
import { acceptIncomingSkill, rejectIncomingSkill } from "./ingest.js";

// Unique per-run names so the accept path's write into CONFIG_DIR/skills is
// cleaned up and never collides with real skills.
const ACCEPT_NAME = "__f6-accept-credit-test__";
const REJECT_NAME = "__f6-reject-credit-test__";

async function stageQuarantined(
  quarantineDir: string,
  name: string,
  authorPubkey: string,
): Promise<void> {
  const dir = path.join(quarantineDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\nbody`, "utf-8");
  await fs.writeFile(
    path.join(dir, ".envelope.json"),
    JSON.stringify({ name, author_pubkey: authorPubkey, author_peer_id: "peerX" }),
    "utf-8",
  );
}

describe("accept/reject credit the peer (F6)", () => {
  let tmp: string;
  let cfg: BitterbotConfig;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-accept-credit-"));
    cfg = { skills: { p2p: { quarantineDir: path.join(tmp, "skills-incoming") } } };
    await fs.mkdir(path.join(tmp, "skills-incoming"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fs
      .rm(path.join(CONFIG_DIR, "skills", ACCEPT_NAME), { recursive: true, force: true })
      .catch(() => {});
  });

  it("accept records a positive ingestion for the envelope author", async () => {
    await stageQuarantined(path.join(tmp, "skills-incoming"), ACCEPT_NAME, "PUBKEY_AAA");
    const recordIngestionResult = vi.fn();

    const result = await acceptIncomingSkill({
      skillName: ACCEPT_NAME,
      config: cfg,
      workspaceDir: tmp,
      reputationManager: { recordIngestionResult },
    });

    expect(result.ok).toBe(true);
    expect(recordIngestionResult).toHaveBeenCalledTimes(1);
    expect(recordIngestionResult).toHaveBeenCalledWith("PUBKEY_AAA", true);
  });

  it("reject records a negative ingestion for the envelope author", async () => {
    await stageQuarantined(path.join(tmp, "skills-incoming"), REJECT_NAME, "PUBKEY_BBB");
    const recordIngestionResult = vi.fn();

    const result = await rejectIncomingSkill({
      skillName: REJECT_NAME,
      config: cfg,
      reputationManager: { recordIngestionResult },
    });

    expect(result.ok).toBe(true);
    expect(recordIngestionResult).toHaveBeenCalledWith("PUBKEY_BBB", false);
  });

  it("accept without a reputation manager still succeeds (no throw)", async () => {
    await stageQuarantined(path.join(tmp, "skills-incoming"), ACCEPT_NAME, "PUBKEY_CCC");
    const result = await acceptIncomingSkill({
      skillName: ACCEPT_NAME,
      config: cfg,
      workspaceDir: tmp,
    });
    expect(result.ok).toBe(true);
  });
});
