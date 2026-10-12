/**
 * PLAN-55 Phase 3, through the real manager: a forgotten transcript passage
 * stays out when the unchanged transcript is indexed again, deleting the
 * conversation retires what rested only on it, and export -> import round
 * trips through the manager's owner methods.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { CanonicalFactsStore } from "./canonical-facts.js";
import { getMemorySearchManager } from "./index.js";
import { buildSessionEntry } from "./session-files.js";

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));
vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));
vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

type Mgr = {
  db: DatabaseSync;
  indexFile: (e: unknown, o: { source: string }) => Promise<void>;
  canonicalFacts: () => CanonicalFactsStore | null;
  ownerForgetMemory: (id: string, o?: { planHash?: string }) => Promise<unknown>;
  ownerForgetSession: (
    files: string[],
  ) => Promise<{ retiredFacts: unknown[]; survivors: unknown[] }>;
  ownerExportTo: (sink: (p: string) => void) => Promise<{ memories: number }>;
  ownerImportMemories: (
    input: unknown,
    o?: { dryRun?: boolean },
  ) => Promise<{ memories: { imported: number } }>;
  close: () => Promise<void>;
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(lines: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-cascade-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const workspaceDir = path.join(root, "workspace");
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "session-a.jsonl");
  await fs.writeFile(
    sessionFile,
    lines
      .map((content, i) =>
        JSON.stringify({
          type: "message",
          message: { role: i % 2 ? "assistant" : "user", content },
        }),
      )
      .join("\n") + "\n",
  );
  const { manager } = await getMemorySearchManager({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            sources: ["memory", "sessions"],
            store: { path: path.join(root, "idx.sqlite"), vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: true } },
            sessionsDir,
            chunking: { tokens: 20, overlap: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as never,
    agentId: "main",
  });
  const mgr = manager as unknown as Mgr;
  cleanup.push(async () => {
    await mgr?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const index = async () =>
    mgr.indexFile(await buildSessionEntry(sessionFile), { source: "sessions" });
  await index();
  return { mgr, sessionFile, index };
}

const sessionChunks = (db: DatabaseSync) =>
  db
    .prepare(`SELECT id, text FROM chunks WHERE source = 'sessions' ORDER BY start_line`)
    .all() as Array<{ id: string; text: string }>;

describe("forget cascade through the manager", () => {
  it("a forgotten transcript passage is not indexed again", async () => {
    const { mgr, index } = await boot([
      "My home city is Lisbon and I have lived there for years now, really.",
      "Noted, Lisbon it is.",
      "Completely unrelated: the build server is called hal and runs on the third floor.",
    ]);
    const before = sessionChunks(mgr.db);
    expect(before.length).toBeGreaterThan(1);
    const target = before.find((c) => /Lisbon/.test(c.text))!;
    await mgr.ownerForgetMemory(target.id);
    expect(sessionChunks(mgr.db).some((c) => c.id === target.id)).toBe(false);

    await index();
    const after = sessionChunks(mgr.db);
    expect(after.some((c) => c.text === target.text)).toBe(false);
    expect(after.length).toBe(before.length - 1);
  });

  it("deleting the conversation retires facts resting only on it", async () => {
    const { mgr, sessionFile } = await boot(["We use pnpm in every repo here.", "Got it."]);
    const chunk = sessionChunks(mgr.db)[0]!;
    const store = mgr.canonicalFacts()!;
    store.pin({
      key: "project.package_manager",
      value: "pnpm",
      source: "extraction",
      evidenceChunkIds: [chunk.id],
    });
    store.pin({
      key: "identity.name",
      value: "Victor",
      source: "owner",
      evidenceChunkIds: [chunk.id],
    });
    const result = await mgr.ownerForgetSession([sessionFile]);
    expect(store.get("project.package_manager")?.status).toBe("retired");
    expect(store.get("identity.name")?.status).toBe("active");
    expect(result.survivors).toEqual([{ key: "identity.name", value: "Victor", reason: "owner" }]);
    expect(sessionChunks(mgr.db)).toEqual([]);
  });

  it("exports and imports through the owner methods", async () => {
    const { mgr } = await boot(["hello there", "hi"]);
    let out = "";
    const stats = await mgr.ownerExportTo((p) => {
      out += p;
    });
    expect(JSON.parse(out).version).toBe(2);
    expect(stats.memories).toBeGreaterThan(0);
    const doc = JSON.parse(out) as { memories: unknown[] };
    doc.memories.push({ id: "note_imported", text: "An imported note." });
    const res = await mgr.ownerImportMemories(doc, { dryRun: false });
    expect(res.memories.imported).toBe(1);
    expect(mgr.db.prepare(`SELECT origin FROM chunks WHERE id = 'note_imported'`).get()).toEqual({
      origin: "import",
    });
  });
});
