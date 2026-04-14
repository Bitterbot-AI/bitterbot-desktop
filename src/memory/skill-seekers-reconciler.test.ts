import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import { mergeProvenance, reconcileEnvelope, scoreEnvelope } from "./skill-seekers-reconciler.js";

function makeEnvelope(overrides: Partial<SkillEnvelope> = {}): SkillEnvelope {
  const base: SkillEnvelope = {
    version: 1,
    skill_md: "",
    name: "react-reference",
    author_peer_id: "local-skill-seekers",
    author_pubkey: "pubkey-a",
    signature: "sig",
    timestamp: Date.now(),
    content_hash: "hash-incoming",
    stable_skill_id: "ss:react-reference",
    skill_version: 1,
    tags: ["external-generated", "source:https://react.dev/reference/react"],
    category: "docs",
  };
  return { ...base, ...overrides };
}

describe("skill-seekers-reconciler", () => {
  let tmp: string;
  let skillsDir: string;
  let quarantineDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
    skillsDir = path.join(tmp, "skills");
    quarantineDir = path.join(tmp, "skills-incoming");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(quarantineDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function placeQuarantined(
    name: string,
    envelope: SkillEnvelope,
    skillMdBytes: number,
    opts: { referenceCount?: number } = {},
  ): void {
    const dir = path.join(quarantineDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(skillMdBytes), "utf8");
    fs.writeFileSync(path.join(dir, ".envelope.json"), JSON.stringify(envelope), "utf8");
    if ((opts.referenceCount ?? 0) > 0) {
      const refs = path.join(dir, "references");
      fs.mkdirSync(refs, { recursive: true });
      for (let i = 0; i < (opts.referenceCount ?? 0); i++) {
        fs.writeFileSync(path.join(refs, `ref-${i}.md`), "ref", "utf8");
      }
    }
  }

  function placeAccepted(
    name: string,
    envelope: SkillEnvelope,
    skillMdBytes: number,
    opts: { referenceCount?: number } = {},
  ): void {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(skillMdBytes), "utf8");
    fs.writeFileSync(path.join(dir, ".provenance.json"), JSON.stringify(envelope), "utf8");
    if ((opts.referenceCount ?? 0) > 0) {
      const refs = path.join(dir, "references");
      fs.mkdirSync(refs, { recursive: true });
      for (let i = 0; i < (opts.referenceCount ?? 0); i++) {
        fs.writeFileSync(path.join(refs, `ref-${i}.md`), "ref", "utf8");
      }
    }
  }

  describe("reconcileEnvelope", () => {
    it("returns ingest-new when no existing skill with the same stable_skill_id", async () => {
      const incoming = makeEnvelope();
      const d = await reconcileEnvelope(incoming, 5000, { skillsDir, quarantineDir });
      expect(d.action).toBe("ingest-new");
    });

    it("returns ingest-new for envelopes without a stable_skill_id", async () => {
      const incoming = makeEnvelope({ stable_skill_id: undefined });
      const d = await reconcileEnvelope(incoming, 5000, { skillsDir, quarantineDir });
      expect(d.action).toBe("ingest-new");
    });

    it("replaces when incoming is meaningfully larger + more references", async () => {
      const existing = makeEnvelope({
        content_hash: "hash-old",
        timestamp: Date.now() - 30 * 86400_000, // 30 days old
      });
      placeQuarantined("react-reference", existing, 2000, { referenceCount: 0 });

      const incoming = makeEnvelope({ content_hash: "hash-new" });
      const d = await reconcileEnvelope(incoming, 20_000, { skillsDir, quarantineDir });
      expect(d.action).toBe("replace");
      if (d.action === "replace") {
        expect(d.existingName).toBe("react-reference");
        expect(d.mergedProvenance).toHaveProperty("reconcile_count");
      }
    });

    it("skips when existing is meaningfully larger", async () => {
      const existing = makeEnvelope({
        content_hash: "hash-old",
        tags: ["external-generated", "source:https://developer.mozilla.org/react-reference"],
      });
      placeAccepted("react-reference", existing, 50_000, { referenceCount: 10 });

      const incoming = makeEnvelope({ content_hash: "hash-new" });
      const d = await reconcileEnvelope(incoming, 1000, { skillsDir, quarantineDir });
      expect(d.action).toBe("skip-incoming");
      if (d.action === "skip-incoming") {
        expect(d.existingName).toBe("react-reference");
      }
    });

    it("writes as variant when scores are comparable", async () => {
      // Both sources have the same authority tier (github.com) and similar size,
      // so neither margin fires and we keep both.
      const existing = makeEnvelope({
        content_hash: "hash-old",
        tags: ["external-generated", "source:https://github.com/facebook/react"],
      });
      placeQuarantined("react-reference", existing, 10_000);

      const incoming = makeEnvelope({
        content_hash: "hash-new",
        tags: ["external-generated", "source:https://github.com/facebook/react"],
      });
      const d = await reconcileEnvelope(incoming, 10_200, { skillsDir, quarantineDir });
      expect(d.action).toBe("write-as-variant");
    });

    it("prefers accepted skills over quarantined ones when both match", async () => {
      const accepted = makeEnvelope({ content_hash: "hash-accepted" });
      placeAccepted("react-reference", accepted, 50_000, { referenceCount: 5 });
      const quarantined = makeEnvelope({ content_hash: "hash-quarantined" });
      placeQuarantined("react-reference-q", quarantined, 5000);

      const incoming = makeEnvelope({ content_hash: "hash-new" });
      const d = await reconcileEnvelope(incoming, 2000, { skillsDir, quarantineDir });
      // Accepted wins the lookup because skillsDir is checked first.
      expect(d.action).toBe("skip-incoming");
      if (d.action === "skip-incoming") {
        expect(d.existingName).toBe("react-reference");
      }
    });
  });

  describe("scoreEnvelope", () => {
    it("scores larger SKILL.md higher", () => {
      const envelope = makeEnvelope();
      const small = scoreEnvelope(envelope, 1000);
      const large = scoreEnvelope(envelope, 50_000);
      expect(large).toBeGreaterThan(small);
    });

    it("bonuses docs.*/github.com origins", () => {
      const generic = makeEnvelope({
        tags: ["external-generated", "source:https://random-blog.example.com/react"],
      });
      const authoritative = makeEnvelope({
        tags: ["external-generated", "source:https://docs.python.org/3/reference"],
      });
      expect(scoreEnvelope(authoritative, 5000)).toBeGreaterThan(scoreEnvelope(generic, 5000));
    });

    it("penalizes very old envelopes (recency boost diminishes)", () => {
      const fresh = makeEnvelope({ timestamp: Date.now() });
      const stale = makeEnvelope({ timestamp: Date.now() - 365 * 86400_000 });
      expect(scoreEnvelope(fresh, 5000)).toBeGreaterThan(scoreEnvelope(stale, 5000));
    });
  });

  describe("mergeProvenance", () => {
    it("merges source URLs, preserves earliest first_seen_at, bumps counter", () => {
      const existing = makeEnvelope({
        provenance: {
          source_url: "https://github.com/facebook/react",
          first_seen_at: 1000,
          reconcile_count: 2,
        },
      });
      const incoming = makeEnvelope({
        provenance: { source_url: "https://react.dev/reference" },
      });
      const merged = mergeProvenance(existing, incoming);
      expect(merged.source_urls).toEqual(
        expect.arrayContaining([
          "https://github.com/facebook/react",
          "https://react.dev/reference",
        ]),
      );
      expect(merged.first_seen_at).toBe(1000);
      expect(merged.reconcile_count).toBe(3);
      expect(merged).toHaveProperty("last_reconciled_at");
    });

    it("pulls URLs from tags when provenance is absent", () => {
      const existing = makeEnvelope({
        tags: ["external-generated", "source:https://a.example.com"],
        provenance: undefined,
      });
      const incoming = makeEnvelope({
        tags: ["external-generated", "source:https://b.example.com"],
      });
      const merged = mergeProvenance(existing, incoming);
      expect(merged.source_urls).toEqual(
        expect.arrayContaining(["https://a.example.com", "https://b.example.com"]),
      );
    });
  });
});
