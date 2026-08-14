import type { DatabaseSync } from "node:sqlite";
/**
 * A session must not hold unindexed content indefinitely.
 *
 * Measured 2026-08-13: session re-indexing fired ONLY on the delta thresholds
 * (defaults 100,000 bytes / 50 messages). A 59 KB session sat unindexed for
 * over four hours across a dozen turns, including two explicit standing
 * preferences the operator stated out loud — neither reached user_preferences,
 * because the extractors only ever see session text at index time. The regex
 * preference extractor had produced ZERO rows in its entire lifetime for the
 * same reason. Everything downstream of session text (preferences, canonical
 * facts, proactive recall) inherits that blindness.
 *
 * The thresholds are still correct as a churn guard; they just needed a
 * deadline. These tests drive the real manager and assert that content below
 * the threshold still becomes searchable.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

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

type SessionManagerUnderTest = MemoryIndexManager & {
  sync: (o?: unknown) => Promise<unknown>;
  db: DatabaseSync;
  sessionDeltas: Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number; pendingSince?: number }
  >;
  sessionPendingFiles: Set<string>;
  sessionsDirtyFiles: Set<string>;
  processSessionDeltaBatch: () => Promise<void>;
};

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-session-stale-"));
  const workspaceDir = path.join(root, "workspace");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "session-a.jsonl");
  await fs.writeFile(sessionFile, "", "utf8");

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
            sync: {
              watch: false,
              onSessionStart: false,
              onSearch: false,
              // Production defaults: a normal conversation never reaches these.
              sessions: { deltaBytes: 100_000, deltaMessages: 50 },
            },
            query: { minScore: 0, hybrid: { enabled: true } },
            sessionsDir,
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as never,
    agentId: "main",
  });
  expect(manager).not.toBeNull();
  const mgr = manager as unknown as SessionManagerUnderTest;
  cleanup.push(async () => {
    await manager?.close();
    // Windows: retry the temp-dir delete — even with close() draining the
    // in-flight sync, AV/indexer services can hold sqlite files briefly.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { mgr, sessionFile };
}

/** One small turn — three orders of magnitude below the byte threshold. */
async function appendTurn(sessionFile: string, text: string): Promise<void> {
  const line = `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;
  await fs.appendFile(sessionFile, line, "utf8");
}

describe("session indexing staleness backstop", () => {
  it("does not mark a small recent turn dirty immediately (threshold still guards churn)", async () => {
    const { mgr, sessionFile } = await boot();
    await appendTurn(sessionFile, "I prefer pnpm over npm for this repo.");

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();

    expect(
      mgr.sessionsDirtyFiles.has(sessionFile),
      "a 60-byte turn should not trigger a re-index on its own",
    ).toBe(false);
    const state = mgr.sessionDeltas.get(sessionFile);
    expect(state?.pendingBytes ?? 0).toBeGreaterThan(0);
    expect(state?.pendingSince, "the clock must start when content goes pending").toBeGreaterThan(
      0,
    );
  });

  it("indexes that turn once it has waited too long", async () => {
    const { mgr, sessionFile } = await boot();
    await appendTurn(sessionFile, "I prefer pnpm over npm for this repo.");

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();
    expect(mgr.sessionsDirtyFiles.has(sessionFile)).toBe(false);

    // Age the pending content past the backstop.
    const state = mgr.sessionDeltas.get(sessionFile)!;
    state.pendingSince = Date.now() - 11 * 60_000;

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();

    expect(
      mgr.sessionsDirtyFiles.has(sessionFile),
      "content held past the deadline must be indexed anyway",
    ).toBe(true);
  });

  it("consumes the pending counters on the real state so it does not re-fire every pass", async () => {
    const { mgr, sessionFile } = await boot();
    await appendTurn(sessionFile, "A standing preference stated out loud.");

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();
    const state = mgr.sessionDeltas.get(sessionFile)!;
    state.pendingSince = Date.now() - 11 * 60_000;

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();

    const after = mgr.sessionDeltas.get(sessionFile)!;
    expect(after.pendingBytes, "pending must reset on the state, not on a returned copy").toBe(0);
    expect(after.pendingSince).toBeUndefined();
  });
});

/**
 * The backstop must also hold when the user goes quiet. The delta batch only
 * runs on a new transcript write, so without this the very case that matters —
 * state a preference, then stop typing — would leave the content pending
 * forever despite the deadline.
 */
describe("staleness is re-checked without further session activity", () => {
  it("lets the periodic sync claim content held past the deadline", async () => {
    const { mgr, sessionFile } = await boot();
    await appendTurn(sessionFile, "I always use ripgrep instead of grep here.");

    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();
    expect(mgr.sessionsDirtyFiles.has(sessionFile)).toBe(false);

    const state = mgr.sessionDeltas.get(sessionFile)!;
    state.pendingSince = Date.now() - 11 * 60_000;
    // Past the manager's first sync, so the "catch up historical sessions"
    // branch does not answer for us.
    (mgr as unknown as { sessionInitialSyncDone: boolean }).sessionInitialSyncDone = true;

    // No new turn, no new delta batch — only the periodic sync's own check.
    const should = (
      mgr as unknown as {
        shouldSyncSessions: (p?: { reason?: string }) => boolean;
      }
    ).shouldSyncSessions({ reason: "interval" });

    expect(should, "the periodic sync must pick up stale pending content").toBe(true);
    expect(mgr.sessionsDirtyFiles.has(sessionFile)).toBe(true);
  });

  it("stays quiet when nothing has been waiting too long", async () => {
    const { mgr, sessionFile } = await boot();
    await appendTurn(sessionFile, "a fresh turn");
    mgr.sessionPendingFiles.add(sessionFile);
    await mgr.processSessionDeltaBatch();
    (mgr as unknown as { sessionInitialSyncDone: boolean }).sessionInitialSyncDone = true;

    const should = (
      mgr as unknown as {
        shouldSyncSessions: (p?: { reason?: string }) => boolean;
      }
    ).shouldSyncSessions({ reason: "interval" });

    expect(should, "recent content must not force a sync").toBe(false);
  });
});
