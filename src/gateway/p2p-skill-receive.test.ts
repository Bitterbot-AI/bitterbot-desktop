import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import type { BitterbotConfig } from "../config/config.js";
import {
  getIngestOutcomeStats,
  resetIngestOutcomeStatsForTest,
} from "../agents/skills/ingest-stats.js";
import { createSkillReceivedHandler } from "./p2p-skill-receive.js";

// Audit finding F15: ingestSkill's self-loopback guard was never handed this
// node's publish key on the live path, so our own skill echoed back by a
// re-publishing peer landed in review as an anonymous peer skill.

type Pair = { pubkeyBase64: string; privateKey: KeyObject };

function keypair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { pubkeyBase64: spki.subarray(-32).toString("base64"), privateKey };
}

function envelope(name: string, body: string, pair: Pair): SkillEnvelope {
  const bytes = Buffer.from(`---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`, "utf-8");
  return {
    version: 1,
    skill_md: bytes.toString("base64"),
    name,
    author_peer_id: "12D3KooWSomeRelay",
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, bytes, pair.privateKey).toString("base64"),
    timestamp: Date.now(),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("P2P skill receive path", () => {
  let tmp: string;
  let quarantine: string;
  const reputation = {
    recordSkillReceived: vi.fn(),
    recordIngestionResult: vi.fn(),
    getTrustLevel: vi.fn(() => "untrusted" as const),
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p2p-receive-"));
    quarantine = path.join(tmp, "skills-incoming");
    resetIngestOutcomeStatsForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function handler(getIdentity: () => Promise<{ pubkey: string }>) {
    const config = {
      skills: { p2p: { ingestPolicy: "review", quarantineDir: quarantine } },
    } as unknown as BitterbotConfig;
    return createSkillReceivedHandler({
      getIdentity,
      loadConfig: () => config,
      getSkillNetworkBridge: () => ({
        getPeerReputation: () => reputation as never,
        ingestNetworkSkill: vi.fn(),
      }),
      log: { warn: vi.fn() },
    });
  }

  async function quarantined(): Promise<string[]> {
    return fs.readdir(quarantine).catch(() => []);
  }

  it("drops our own skill echoed back: no review entry, no reputation, not counted", async () => {
    const me = keypair();
    const h = handler(async () => ({ pubkey: me.pubkeyBase64 }));
    await h.handle(envelope("my-own-skill", "Echoed back by a peer.", me));

    expect(await quarantined()).toEqual([]);
    expect(reputation.recordSkillReceived).not.toHaveBeenCalled();
    expect(reputation.recordIngestionResult).not.toHaveBeenCalled();
    const stats = getIngestOutcomeStats();
    expect(stats.ownEchoesIgnored).toBe(1);
    expect(stats.messages).toBe(0);
    expect(stats.distinctSkills).toBe(0);
  });

  it("still drops the echo when it arrives before the startup identity fetch resolved", async () => {
    const me = keypair();
    let release!: (v: { pubkey: string }) => void;
    const identity = new Promise<{ pubkey: string }>((r) => (release = r));
    const h = handler(() => identity);
    const pending = h.handle(envelope("early-echo", "Arrived first.", me));
    release({ pubkey: me.pubkeyBase64 });
    await pending;
    expect(await quarantined()).toEqual([]);
    expect(getIngestOutcomeStats().ownEchoesIgnored).toBe(1);
  });

  it("a real peer's skill still goes to review", async () => {
    const me = keypair();
    const peer = keypair();
    const h = handler(async () => ({ pubkey: me.pubkeyBase64 }));
    await h.handle(envelope("peer-skill", "Useful peer skill.", peer));
    expect(await quarantined()).toContain("peer-skill");
    expect(reputation.recordSkillReceived).toHaveBeenCalledTimes(1);
    expect(getIngestOutcomeStats()).toMatchObject({
      messages: 1,
      heldForReview: 1,
      ownEchoesIgnored: 0,
    });
  });

  it("an unavailable orchestrator identity does not break receiving", async () => {
    const peer = keypair();
    const h = handler(() => Promise.reject(new Error("orchestrator down")));
    await h.handle(envelope("still-works", "Identity lookup failed.", peer));
    expect(await quarantined()).toContain("still-works");
  });

  it("a burst of messages shares one identity lookup", async () => {
    const me = keypair();
    const getIdentity = vi.fn(async () => ({ pubkey: me.pubkeyBase64 }));
    const h = handler(getIdentity);
    await Promise.all([
      h.handle(envelope("burst-a", "First.", me)),
      h.handle(envelope("burst-b", "Second.", me)),
      h.handle(envelope("burst-c", "Third.", me)),
    ]);
    await h.handle(envelope("burst-d", "Later.", me));
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(getIngestOutcomeStats().ownEchoesIgnored).toBe(4);
  });
});
