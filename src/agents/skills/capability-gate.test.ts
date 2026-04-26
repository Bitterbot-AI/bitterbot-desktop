/**
 * PLAN-13 Phase B: tests for the load-time capability gate.
 *
 * The gate excludes skills whose declared capabilities exceed what their
 * trust tier permits. This test exercises the typical attack scenarios
 * (provisional publisher claiming wallet, untrusted publisher claiming
 * network) plus the benign cases (verified publisher, local skill).
 */

import type { Skill } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityGrant } from "./capability-grants.js";
import type { SkillEntry } from "./types.js";
import {
  applyCapabilityGate,
  evaluateSkillCapabilities,
  loadSkillProvenance,
  type CapabilityGateContext,
} from "./capability-gate.js";

function buildEntry(overrides: {
  baseDir: string;
  name?: string;
  capabilities?: SkillEntry["metadata"] extends infer M
    ? M extends { capabilities?: infer C }
      ? C
      : never
    : never;
}): SkillEntry {
  const skill: Partial<Skill> = {
    name: overrides.name ?? "test-skill",
    description: "test",
    baseDir: overrides.baseDir,
    filePath: path.join(overrides.baseDir, "SKILL.md"),
  };
  return {
    skill: skill as Skill,
    frontmatter: {},
    metadata: overrides.capabilities ? { capabilities: overrides.capabilities } : undefined,
    invocation: { userInvocable: true, disableModelInvocation: false },
  };
}

describe("loadSkillProvenance", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-cap-gate-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no .provenance.json exists", () => {
    const result = loadSkillProvenance({ baseDir: tmp });
    expect(result).toBeNull();
  });

  it("parses author + content hash from provenance", () => {
    fs.writeFileSync(
      path.join(tmp, ".provenance.json"),
      JSON.stringify({
        author_pubkey: "PUB",
        author_peer_id: "12D3KooW",
        content_hash: "abc123",
        ingested_at: 100,
      }),
    );
    const result = loadSkillProvenance({ baseDir: tmp });
    expect(result).toEqual({
      authorPubkey: "PUB",
      authorPeerId: "12D3KooW",
      contentHash: "abc123",
      ingestedAt: 100,
    });
  });

  it("returns null on malformed provenance", () => {
    fs.writeFileSync(path.join(tmp, ".provenance.json"), "not valid json");
    expect(loadSkillProvenance({ baseDir: tmp })).toBeNull();
  });
});

describe("evaluateSkillCapabilities", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-cap-gate-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function withProvenance(authorPubkey: string, contentHash = "h"): string {
    fs.writeFileSync(
      path.join(tmp, ".provenance.json"),
      JSON.stringify({ author_pubkey: authorPubkey, content_hash: contentHash }),
    );
    return tmp;
  }

  it("local skill (no provenance) is admitted regardless of declarations", () => {
    const entry = buildEntry({
      baseDir: tmp,
      capabilities: { wallet: true, shell: true },
    });
    const ctx: CapabilityGateContext = { getTrustTier: () => "local" };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(true);
  });

  it("verified publisher with declared wallet is admitted", () => {
    const baseDir = withProvenance("VERIFIED_PUBKEY");
    const entry = buildEntry({ baseDir, capabilities: { wallet: true } });
    const ctx: CapabilityGateContext = {
      getTrustTier: (k) => (k === "VERIFIED_PUBKEY" ? "verified" : "untrusted"),
    };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(true);
  });

  it("provisional publisher claiming wallet is BLOCKED", () => {
    const baseDir = withProvenance("PROV_PUBKEY");
    const entry = buildEntry({ baseDir, capabilities: { wallet: true } });
    const ctx: CapabilityGateContext = {
      getTrustTier: () => "provisional",
    };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.blockedAxes).toContain("wallet");
      expect(verdict.tier).toBe("provisional");
    }
  });

  it("untrusted publisher claiming network is BLOCKED", () => {
    const baseDir = withProvenance("UNT");
    const entry = buildEntry({
      baseDir,
      capabilities: { network: { outbound: ["api.example.com"] } },
    });
    const ctx: CapabilityGateContext = { getTrustTier: () => "untrusted" };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.blockedAxes).toContain("network");
    }
  });

  it("banned publisher's skill is always blocked", () => {
    const baseDir = withProvenance("BANNED");
    const entry = buildEntry({ baseDir, capabilities: { wallet: true } });
    const ctx: CapabilityGateContext = { getTrustTier: () => "banned" };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.tier).toBe("banned");
    }
  });

  it("operator allow grant rescues a trusted-tier wallet declaration", () => {
    const baseDir = withProvenance("TRU", "hash-a");
    const entry = buildEntry({ baseDir, capabilities: { wallet: true } });
    const grants: CapabilityGrant[] = [
      { contentHash: "hash-a", capability: "wallet", decision: "allow", grantedAt: 1 },
    ];
    const ctx: CapabilityGateContext = {
      getTrustTier: () => "trusted",
      getGrants: () => grants,
    };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(true);
  });

  it("operator deny grant blocks even verified tier", () => {
    const baseDir = withProvenance("VER", "hash-b");
    const entry = buildEntry({ baseDir, capabilities: { wallet: true } });
    const grants: CapabilityGrant[] = [
      { contentHash: "hash-b", capability: "wallet", decision: "deny", grantedAt: 1 },
    ];
    const ctx: CapabilityGateContext = {
      getTrustTier: () => "verified",
      getGrants: () => grants,
    };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.blockedAxes).toContain("wallet");
    }
  });

  it("skill with no declared capabilities is always admitted", () => {
    const baseDir = withProvenance("UNT");
    const entry = buildEntry({ baseDir }); // no capabilities at all
    const ctx: CapabilityGateContext = { getTrustTier: () => "untrusted" };
    const verdict = evaluateSkillCapabilities(entry, ctx);
    expect(verdict.ok).toBe(true);
  });
});

describe("applyCapabilityGate", () => {
  let tmpA: string;
  let tmpB: string;

  beforeEach(() => {
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-cap-gate-A-"));
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-cap-gate-B-"));
  });

  afterEach(() => {
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  });

  it("partitions a mixed batch into permitted and blocked", () => {
    fs.writeFileSync(
      path.join(tmpA, ".provenance.json"),
      JSON.stringify({ author_pubkey: "VER", content_hash: "h1" }),
    );
    fs.writeFileSync(
      path.join(tmpB, ".provenance.json"),
      JSON.stringify({ author_pubkey: "PROV", content_hash: "h2" }),
    );
    const a = buildEntry({
      baseDir: tmpA,
      name: "verified-wallet",
      capabilities: { wallet: true },
    });
    const b = buildEntry({
      baseDir: tmpB,
      name: "provisional-wallet",
      capabilities: { wallet: true },
    });

    const ctx: CapabilityGateContext = {
      getTrustTier: (k) => (k === "VER" ? "verified" : "provisional"),
    };
    const { permitted, blocked } = applyCapabilityGate([a, b], ctx);

    expect(permitted.map((e) => e.skill.name)).toEqual(["verified-wallet"]);
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.entry.skill.name).toBe("provisional-wallet");
  });
});
