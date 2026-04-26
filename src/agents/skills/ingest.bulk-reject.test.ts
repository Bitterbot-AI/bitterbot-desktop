/**
 * PLAN-13 Phase C: tests for rejectIncomingSkillsByPeer.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { rejectIncomingSkillsByPeer } from "./ingest.js";

async function stage(
  root: string,
  name: string,
  envelope: { author_peer_id: string; name: string; timestamp?: number },
): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  await fs.writeFile(
    path.join(dir, ".envelope.json"),
    JSON.stringify({ ...envelope, timestamp: envelope.timestamp ?? Date.now() }),
    "utf-8",
  );
}

describe("rejectIncomingSkillsByPeer", () => {
  let tmp: string;
  let cfg: BitterbotConfig;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-bulk-reject-"));
    cfg = { skills: { p2p: { quarantineDir: path.join(tmp, "skills-incoming") } } };
    await fs.mkdir(path.join(tmp, "skills-incoming"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects all skills from the named peer, leaves others intact", async () => {
    const dir = path.join(tmp, "skills-incoming");
    await stage(dir, "alice-1", { author_peer_id: "12D3Alice", name: "alice-1" });
    await stage(dir, "alice-2", { author_peer_id: "12D3Alice", name: "alice-2" });
    await stage(dir, "bob-1", { author_peer_id: "12D3Bob", name: "bob-1" });

    const result = await rejectIncomingSkillsByPeer({
      authorPeerId: "12D3Alice",
      config: cfg,
    });
    expect(result.ok).toBe(true);
    expect(result.rejected.toSorted()).toEqual(["alice-1", "alice-2"]);
    expect(result.errored).toEqual([]);

    const remaining = await fs.readdir(dir);
    expect(remaining).toEqual(["bob-1"]);
  });

  it("returns empty rejected list when no quarantined skills match", async () => {
    const dir = path.join(tmp, "skills-incoming");
    await stage(dir, "bob-1", { author_peer_id: "12D3Bob", name: "bob-1" });

    const result = await rejectIncomingSkillsByPeer({
      authorPeerId: "12D3Alice",
      config: cfg,
    });
    expect(result.ok).toBe(true);
    expect(result.rejected).toEqual([]);
    const remaining = await fs.readdir(dir);
    expect(remaining).toEqual(["bob-1"]);
  });

  it("clean no-op when quarantine dir is empty", async () => {
    const result = await rejectIncomingSkillsByPeer({
      authorPeerId: "12D3Alice",
      config: cfg,
    });
    expect(result.ok).toBe(true);
    expect(result.rejected).toEqual([]);
  });
});
