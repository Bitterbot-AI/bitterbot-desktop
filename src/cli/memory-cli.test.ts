import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

afterEach(async () => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  process.exitCode = undefined;
  const { setVerbose } = await import("../globals.js");
  setVerbose(false);
});

describe("memory cli", () => {
  it("prints vector status when available", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 2,
          chunks: 5,
          dirty: false,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => false),
        status: () => ({
          files: 0,
          chunks: 0,
          dirty: true,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--agent", "main"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        probeEmbeddingAvailability,
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--deep"], { from: "user" });

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { isVerbose } = await import("../globals.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 0,
          chunks: 0,
          dirty: false,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--verbose"], { from: "user" });

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
        }),
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status"], { from: "user" });

    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("reindexes on status --index", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        probeEmbeddingAvailability,
        sync,
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/bitterbot",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        sync,
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs close failures without failing the command", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const sync = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        sync,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("logs close failure after search", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        search,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "search", "hello"], { from: "user" });

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("closes manager after search error", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        search,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "search", "oops"], { from: "user" });

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });
});

describe("memory cli owner controls (PLAN-55 Phase 3)", () => {
  const preview = {
    planHash: "a".repeat(64),
    counts: { chunks: 1, factsRetired: 1, ownerFactsKept: 0, edgesClosed: 0 },
    factsRetired: [{ key: "infra.deploy_endpoint", value: "api.acme.com" }],
    ownerFactsKept: [],
    factsKeptWithOtherEvidence: [],
    factsRelinked: [],
  };

  function ownerManager(extra: Record<string, unknown> = {}) {
    return {
      ownerForgetPreview: vi.fn(async () => preview),
      ownerForgetMemory: vi.fn(async () => ({ counts: { chunks: 1 }, retiredFacts: [{}] })),
      ownerEditPreview: vi.fn(async () => ({ ...preview, newId: "fact_new" })),
      ownerEditMemory: vi.fn(async () => ({
        id: "fact_new",
        previousId: "fact_1",
        cascade: { counts: {} },
      })),
      ownerExportMemories: vi.fn(async (file: string) => ({
        file,
        memories: 3,
        facts: 2,
        redactions: 0,
      })),
      ownerExportTo: vi.fn(async () => ({})),
      ownerImportMemories: vi.fn(async (_input: unknown, opts?: { dryRun?: boolean }) => ({
        dryRun: Boolean(opts?.dryRun),
        memories: { imported: 2 },
        facts: { imported: 1 },
        preferences: { imported: 0 },
      })),
      ownerDatabasePath: () => "/tmp/main.sqlite",
      close: vi.fn(async () => {}),
      ...extra,
    };
  }

  async function run(args: string[], manager: ReturnType<typeof ownerManager>) {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    getMemorySearchManager.mockResolvedValueOnce({ manager });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
    return {
      out: log.mock.calls.map((c) => String(c[0])).join("\n"),
      err: error.mock.calls.map((c) => String(c[0])).join("\n"),
    };
  }

  it("forget without --yes only shows the cascade", async () => {
    const m = ownerManager();
    const { out } = await run(["forget", "fact_1"], m);
    expect(out).toContain("retire  infra.deploy_endpoint = api.acme.com");
    expect(out).toContain("Re-run with --yes");
    expect(m.ownerForgetMemory).not.toHaveBeenCalled();
    expect(m.close).toHaveBeenCalled();
  });

  it("forget --preview stops after the preview", async () => {
    const m = ownerManager();
    const { out } = await run(["forget", "fact_1", "--preview"], m);
    expect(out).toContain(`Plan: ${"a".repeat(64)}`);
    expect(out).not.toContain("Re-run");
    expect(m.ownerForgetMemory).not.toHaveBeenCalled();
  });

  it("forget --yes applies exactly the previewed plan", async () => {
    const m = ownerManager();
    const { out } = await run(["forget", "fact_1", "--yes"], m);
    expect(m.ownerForgetMemory).toHaveBeenCalledWith("fact_1", { planHash: "a".repeat(64) });
    expect(out).toContain("Forgot fact_1");
  });

  it("edit --yes replaces the memory", async () => {
    const m = ownerManager();
    const { out } = await run(["edit", "fact_1", "new text", "--yes"], m);
    expect(m.ownerEditMemory).toHaveBeenCalledWith("fact_1", "new text", {
      planHash: "a".repeat(64),
    });
    expect(out).toContain("Replaced fact_1 with fact_new");
  });

  it("a refused forget sets the exit code", async () => {
    const m = ownerManager({
      ownerForgetPreview: vi.fn(async () => {
        throw new Error("change the file instead");
      }),
    });
    const { err } = await run(["forget", "abc", "--yes"], m);
    expect(err).toContain("change the file instead");
    expect(process.exitCode).toBe(1);
  });

  it("export writes v2 to --out and shows the database path; other formats are refused", async () => {
    const m = ownerManager();
    const { out } = await run(["export", "--out", "/tmp/x/export.json"], m);
    const { resolve } = await import("node:path");
    // Resolved against the platform (a drive letter on Windows).
    expect(m.ownerExportMemories).toHaveBeenCalledWith(resolve("/tmp/x/export.json"));
    expect(out).toContain("3 memories");
    expect(out).toContain("main.sqlite");

    const m2 = ownerManager();
    const { err } = await run(["export", "--format", "v1"], m2);
    expect(err).toContain("only v2");
    expect(process.exitCode).toBe(1);
  });

  it("import --dry-run reads the file and writes nothing", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-import-cli-"));
    const file = path.join(dir, "export.json");
    await fs.writeFile(file, JSON.stringify({ version: 2, memories: [] }));
    const m = ownerManager();
    const { out } = await run(["import", file, "--dry-run"], m);
    expect(m.ownerImportMemories).toHaveBeenCalledWith(
      { version: 2, memories: [] },
      { dryRun: true, actor: "owner", keepOwnerTier: false, confirmOwnerTierGrants: undefined },
    );
    expect(out).toContain("Dry run, nothing written.");
    expect(out).toContain("Memories: imported 2");
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function exportFile(): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-import-cli-"));
    const file = path.join(dir, "export.json");
    await fs.writeFile(file, JSON.stringify({ version: 2, memories: [] }));
    return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  it("--keep-owner-tier without a terminal and without --yes refuses (rule C)", async () => {
    const { file, cleanup } = await exportFile();
    const m = ownerManager({
      ownerImportMemories: vi.fn(async (_i: unknown, opts?: { dryRun?: boolean }) => ({
        dryRun: Boolean(opts?.dryRun),
        ownerTierGrants: 2,
        memories: {},
        facts: {},
        preferences: {},
      })),
    });
    const { out, err } = await run(["import", file, "--keep-owner-tier"], m);
    expect(out).toContain(
      "This will give 2 facts owner authority (they will override the agent and win every conflict)",
    );
    expect(err).toContain("--yes");
    expect(m.ownerImportMemories).toHaveBeenCalledTimes(1);
    expect(m.ownerImportMemories).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
      actor: "owner",
      keepOwnerTier: true,
    });
    expect(process.exitCode).toBe(1);
    await cleanup();
  });

  it("--keep-owner-tier --yes applies with the dry run's count", async () => {
    const { file, cleanup } = await exportFile();
    const m = ownerManager({
      ownerImportMemories: vi.fn(async (_i: unknown, opts?: { dryRun?: boolean }) => ({
        dryRun: Boolean(opts?.dryRun),
        ownerTierGrants: 2,
        memories: {},
        facts: {},
        preferences: {},
      })),
    });
    const { out } = await run(["import", file, "--keep-owner-tier", "--yes"], m);
    expect(m.ownerImportMemories).toHaveBeenLastCalledWith(expect.anything(), {
      dryRun: false,
      actor: "owner",
      keepOwnerTier: true,
      confirmOwnerTierGrants: 2,
    });
    expect(out).toContain("Owner-tier grants: 2");
    await cleanup();
  });

  it("import of a missing file fails cleanly", async () => {
    const m = ownerManager();
    const { err } = await run(["import", "/nonexistent/export.json"], m);
    expect(err).toContain("Cannot read");
    expect(m.ownerImportMemories).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
