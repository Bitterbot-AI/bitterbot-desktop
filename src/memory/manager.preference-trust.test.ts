/**
 * Only the owner's own conversations may teach preferences about the owner.
 * The pattern-based extractor ran on every indexed session, so "I prefer X"
 * said in a group chat or by a guest became the owner's preference.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function indexSessionAs(sessionKey: string): Promise<number> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-pref-trust-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const workspaceDir = path.join(root, "workspace");
  const sessionsDir = path.join(root, ".bitterbot", "agents", "main", "sessions");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "session-a.jsonl");
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: "I prefer pnpm over npm for every repo." } })}\n`,
  );
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({ [sessionKey]: { sessionId: "session-a", updatedAt: Date.now() } }),
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
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as never,
    agentId: "main",
  });
  cleanup.push(async () => {
    await manager?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const mgr = manager as unknown as {
    db: DatabaseSync;
    indexFile: (e: unknown, o: { source: string }) => Promise<void>;
  };
  await mgr.indexFile(await buildSessionEntry(sessionFile), { source: "sessions" });
  try {
    return (mgr.db.prepare("SELECT count(*) AS n FROM user_preferences").get() as { n: number }).n;
  } catch {
    return 0;
  }
}

describe("pattern-based preference learning", () => {
  it("learns from the owner's own conversation", async () => {
    expect(await indexSessionAs("agent:main:main")).toBeGreaterThan(0);
  });

  it("does not learn the owner's preferences from a group chat", async () => {
    expect(await indexSessionAs("agent:main:telegram:group:-100123")).toBe(0);
  });
});
