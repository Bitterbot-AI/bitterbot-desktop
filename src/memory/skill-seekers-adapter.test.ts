import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing adapter
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("not found");
  }),
  // execFile is used via promisify for async CLI runs; tests don't exercise a
  // successful scrape (all test paths reject before the CLI runs), so a stub
  // that calls back with an error is sufficient.
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
    if (typeof cb === "function") {
      cb(new Error("not found"));
    }
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
    it("returns true when enabled (native transport is always available)", async () => {
      // After the hybrid refactor, isAvailable() reports readiness of the
      // adapter as a whole, not of any specific upstream transport. Native
      // covers docs + GitHub even when no Python / MCP is installed.
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      expect(await adapter.isAvailable()).toBe(true);
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
      (adapter as unknown as { transportProbe: null }).transportProbe = null;
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
      (adapter as unknown as { transportProbe: null }).transportProbe = null;

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
      (adapter as unknown as { transportProbe: null }).transportProbe = null;
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
      (adapter as unknown as { transportProbe: null }).transportProbe = null;

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
      (adapter as unknown as { transportProbe: null }).transportProbe = null;

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

  describe("budget tracking", () => {
    it("exposes remaining budget derived from maxSkillsPerCycle", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, { maxSkillsPerCycle: 5 });
      expect(adapter.budgetRemaining()).toBe(5);
      (adapter as unknown as { skillsGeneratedThisCycle: number }).skillsGeneratedThisCycle = 3;
      expect(adapter.budgetRemaining()).toBe(2);
      (adapter as unknown as { skillsGeneratedThisCycle: number }).skillsGeneratedThisCycle = 10;
      // Clamped to zero — never negative.
      expect(adapter.budgetRemaining()).toBe(0);
    });
  });

  describe("web search fallback", () => {
    it("delegates to the injected URL finder for URL-less gaps", async () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === "skill-seekers") {
          return "3.4.0\n";
        }
        throw new Error("not found");
      });

      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      (adapter as unknown as { transportProbe: null }).transportProbe = null;

      const findUrl = vi.fn(async () => "https://docs.example.com/api");
      adapter.setWebSearch({ findAuthoritativeUrl: findUrl });

      const result = await adapter.fillKnowledgeGap("how does foo widget work");
      expect(findUrl).toHaveBeenCalledTimes(1);
      // Actual scrape will still fail (mocked execFile rejects), but sourceUrl
      // should reflect the URL the finder returned.
      expect(result.sourceUrl).toBe("https://docs.example.com/api");
    });

    it("returns no_url_in_gap_description when finder returns null", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      adapter.setWebSearch({ findAuthoritativeUrl: async () => null });

      const result = await adapter.fillKnowledgeGap("arbitrary topic with no url");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_url_in_gap_description");
    });

    it("honors domain filter on URLs returned by the finder", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, { blockedDomains: ["evil.com"] });
      adapter.setWebSearch({
        findAuthoritativeUrl: async () => "https://evil.com/docs",
      });

      const result = await adapter.fillKnowledgeGap("some topic");
      expect(result.error).toBe("domain_blocked_via_search");
    });
  });

  describe("marketplace integration", () => {
    it("ingestFromMarketOpportunities returns empty when no intelligence wired", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      const batch = await adapter.ingestFromMarketOpportunities(() => null);
      expect(batch.total).toBe(0);
      expect(batch.succeeded).toBe(0);
    });

    it("ingestFromMarketOpportunities skips opportunities whose URL resolves to null", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      adapter.setMarketplaceIntelligence({
        analyzeOpportunities: () => [
          {
            category: "weather-apis",
            demandScore: 0.8,
            readinessScore: 0.5,
            expectedRevenueUsdc: 10,
            targetDescription: "Weather APIs in demand",
          },
        ],
      });
      const resolveUrl = vi.fn(() => null);
      const batch = await adapter.ingestFromMarketOpportunities(resolveUrl);
      expect(resolveUrl).toHaveBeenCalledWith("weather-apis");
      expect(batch.total).toBe(0);
    });
  });

  describe("transport selection", () => {
    it("isAvailable returns true when enabled even without any upstream transport", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      // Native is always available so adapter reports ready even when CLI/MCP are missing.
      expect(await adapter.isAvailable()).toBe(true);
    });

    it("isAvailable returns false when explicitly disabled", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db, { enabled: false });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("picks native for docs URLs and github for repo URLs", async () => {
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      const resolve = (
        adapter as unknown as {
          resolveTransport: (url: string) => Promise<string>;
        }
      ).resolveTransport.bind(adapter);
      expect(await resolve("https://docs.python.org/3/")).toBe("native");
      expect(await resolve("https://github.com/nodejs/node")).toBe("native");
    });

    it("falls back to upstream probe for PDF URLs (no upstream = null)", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const { SkillSeekersAdapter } = await import("./skill-seekers-adapter.js");
      const db = createTestDb();
      const adapter = new SkillSeekersAdapter(db);
      const resolve = (
        adapter as unknown as {
          resolveTransport: (url: string) => Promise<string | null>;
        }
      ).resolveTransport.bind(adapter);
      expect(await resolve("https://example.com/paper.pdf")).toBeNull();
    });
  });
});
