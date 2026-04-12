import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing adapter
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

// Mock the ingestSkill function
vi.mock("../agents/skills/ingest.js", () => ({
  ingestSkill: vi.fn(async () => ({
    ok: true,
    action: "quarantined" as const,
    skillName: "test-skill",
    reason: "untrusted peer",
  })),
}));

// Lazy import to pick up mocks
const { execFileSync } = await import("node:child_process");
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;

describe("SkillSeekersAdapter", () => {
  let DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module cache for adapter
    const sqlite = await import("node:sqlite");
    DatabaseSync = sqlite.DatabaseSync;
  });

  function createTestDb(): import("node:sqlite").DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_reputation (
        peer_pubkey TEXT PRIMARY KEY,
        peer_id TEXT,
        skills_received INTEGER DEFAULT 0,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        is_trusted INTEGER DEFAULT 0,
        reputation_score REAL DEFAULT 0.5
      )
    `);
    return db;
  }

  describe("isAvailable", () => {
    it("returns false when CLI is not installed", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("returns true when direct CLI is available", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      // Reset cached availability
      (adapter as unknown as { available: null }).available = null;
      expect(await adapter.isAvailable()).toBe(true);
    });

    it("returns false when disabled in config", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, { enabled: false });
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe("synthetic peer", () => {
    it("registers synthetic peer with valid Ed25519 pubkey", async () => {
      const { SkillSeekersAdapter, SKILL_SEEKERS_PEER_ID } =
        await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const adapter = new SkillSeekersAdapter(db);

      const row = db
        .prepare("SELECT * FROM peer_reputation WHERE peer_pubkey = ?")
        .get(adapter.pubkey) as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row?.peer_id).toBe(SKILL_SEEKERS_PEER_ID);
      expect(row?.reputation_score).toBe(0.5);
      expect(row?.is_trusted).toBe(0);
      // Verify pubkey is valid base64 and 32 bytes (Ed25519 raw key)
      const pubkeyBytes = Buffer.from(adapter.pubkey, "base64");
      expect(pubkeyBytes.length).toBe(32);
    });

    it("persists keypair across instances", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const adapter1 = new SkillSeekersAdapter(db);
      const adapter2 = new SkillSeekersAdapter(db);
      expect(adapter1.pubkey).toBe(adapter2.pubkey);
    });
  });

  describe("domain filtering", () => {
    it("blocks domains on the blocklist", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, {
        blockedDomains: ["evil.com"],
      });
      (adapter as unknown as { available: null }).available = null;

      const result = await adapter.ingestFromSource({ url: "https://evil.com/docs" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("domain_blocked");
    });

    it("allows domains on the allowlist", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, {
        allowedDomains: ["good.com"],
      });

      // isDomainAllowed is private — test via ingestFromSource
      // (will fail because CLI is mocked to throw, but won't fail on domain check)
      const result = await adapter.ingestFromSource({ url: "https://bad.com/docs" });
      // If domain filter is working, it blocks before reaching CLI
      expect(result.ok).toBe(false);
      expect(result.error).toBe("domain_blocked");
    });
  });

  describe("rate limiting", () => {
    it("respects maxSkillsPerCycle", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, { maxSkillsPerCycle: 1 });
      (adapter as unknown as { available: null }).available = null;
      // Simulate one skill already generated
      (adapter as unknown as { skillsGeneratedThisCycle: number }).skillsGeneratedThisCycle = 1;

      const result = await adapter.ingestFromSource({ url: "https://docs.example.com" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("rate_limit_exceeded");
    });

    it("resets counter on resetCycleCounter", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      (adapter as unknown as { skillsGeneratedThisCycle: number }).skillsGeneratedThisCycle = 5;
      adapter.resetCycleCounter();
      expect(
        (adapter as unknown as { skillsGeneratedThisCycle: number }).skillsGeneratedThisCycle,
      ).toBe(0);
    });
  });

  describe("fillKnowledgeGap", () => {
    it("returns gracefully when no URL in gap description", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      (adapter as unknown as { available: null }).available = null;

      const result = await adapter.fillKnowledgeGap("How does React reconciliation work?");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_url_in_gap_description");
    });

    it("extracts URL from gap description and delegates to ingestFromSource", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      (adapter as unknown as { available: null }).available = null;

      const result = await adapter.fillKnowledgeGap(
        "Need docs on https://react.dev/reference/react",
      );
      // Will fail at CLI execution, but proves URL was extracted
      expect(result.sourceUrl).toBe("https://react.dev/reference/react");
    });
  });

  describe("conflict processing", () => {
    it("creates epistemic directives for high-severity conflicts", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);

      const mockEngine = { createDirective: vi.fn() };
      adapter.setEpistemicDirectiveEngine(mockEngine);

      // Access processConflicts via adapter internals
      const processConflicts = (
        adapter as unknown as { processConflicts: Function }
      ).processConflicts.bind(adapter);
      processConflicts(
        [
          {
            type: "missing_in_code",
            severity: "high",
            apiName: "Widget.render",
            difference: "API documented but not found in code",
            suggestion: "Update documentation",
          },
          {
            type: "missing_in_docs",
            severity: "medium",
            apiName: "Widget.update",
            difference: null,
            suggestion: null,
          },
        ],
        "https://example.com",
      );

      // Only high-severity should create directive
      expect(mockEngine.createDirective).toHaveBeenCalledTimes(1);
      expect(mockEngine.createDirective).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "contradiction",
          priority: 0.8,
        }),
      );
    });

    it("caps directives at 2 per ingestion", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);

      const mockEngine = { createDirective: vi.fn() };
      adapter.setEpistemicDirectiveEngine(mockEngine);

      const processConflicts = (
        adapter as unknown as { processConflicts: Function }
      ).processConflicts.bind(adapter);
      processConflicts(
        Array.from({ length: 5 }, (_, i) => ({
          type: "missing_in_code" as const,
          severity: "high" as const,
          apiName: `API_${i}`,
          difference: "missing",
          suggestion: null,
        })),
        "https://example.com",
      );

      expect(mockEngine.createDirective).toHaveBeenCalledTimes(2);
    });
  });
});
