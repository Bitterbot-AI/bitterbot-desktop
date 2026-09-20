/**
 * Token-efficiency pass (2026-09-19) — MANAGER WIRING for the extraction
 * gates. Drives the real private runSessionExtraction against real
 * transcript files (same harness as manager.extraction-wiring.test.ts):
 * - a heartbeat-only transcript makes no LLM call;
 * - a transcript whose extraction fails is retried at most maxAttempts
 *   times, then parked until its content changes;
 * - a success clears the ledger.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExtractionFailure } from "./extraction-failures.js";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const AGENT_ID = "gatetest";
const HB_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

describe("runSessionExtraction gates (heartbeat filter + failure ledger)", () => {
  let stateDir: string;
  let workspaceDir: string;
  let savedStateDir: string | undefined;
  let db: DatabaseSync;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gate-state-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gate-ws-"));
    savedStateDir = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.BITTERBOT_STATE_DIR;
    } else {
      process.env.BITTERBOT_STATE_DIR = savedStateDir;
    }
    db.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, turns: Array<[role: string, text: string]>): string {
    const sessionsDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const records = turns.map(([role, text]) => ({
      type: "message",
      message: { role, content: [{ type: "text", text }] },
    }));
    const file = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ [`agent:${AGENT_ID}`]: { sessionId } }),
    );
    return file;
  }

  function makeFakeManager(llmCall: (prompt: string) => Promise<string>) {
    return {
      cfg: {
        memory: {
          extraction: { minSessionDelta: 10, maxAttempts: 2 },
          architectEvolution: { enabled: false },
        },
      },
      agentId: AGENT_ID,
      db,
      dreamLlmCall: llmCall,
      hormonalManager: null,
      epistemicDirectiveEngine: null,
      canonicalFactsStore: null,
      userModelManager: null,
      knowledgeGraph: null,
      workspaceDir,
    };
  }

  async function runExtraction(fake: unknown): Promise<void> {
    const proto = MemoryIndexManager.prototype as unknown as {
      runSessionExtraction(this: unknown): Promise<void>;
    };
    await proto.runSessionExtraction.call(fake);
  }

  it("a heartbeat-only transcript makes no extraction call and writes no handover", async () => {
    let calls = 0;
    const fake = makeFakeManager(async () => {
      calls++;
      return "{}";
    });
    const turns: Array<[string, string]> = [];
    for (let i = 0; i < 48; i++) {
      turns.push(["user", HB_PROMPT], ["assistant", "HEARTBEAT_OK"]);
    }
    writeSession("sess-hb", turns);
    await runExtraction(fake);
    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(workspaceDir, "memory", "handover"))).toBe(false);
  });

  it("a failing transcript is retried maxAttempts times, then parked; new content resets", async () => {
    let calls = 0;
    const fake = makeFakeManager(async () => {
      calls++;
      return '{"facts": [{"text": "cut off'; // truncated JSON, never parses
    });
    const file = writeSession("sess-bad", [
      ["user", "the gateway is a2a.new.example now, we cut over yesterday"],
      ["assistant", "noted, updating the runbook accordingly"],
    ]);

    await runExtraction(fake);
    await runExtraction(fake);
    await runExtraction(fake);
    await runExtraction(fake);
    expect(calls).toBe(2);
    const row = readExtractionFailure(db, file);
    expect(row?.attempts).toBe(2);

    // Content change => one fresh attempt.
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "also rotate the key" }] },
      }) + "\n",
    );
    await runExtraction(fake);
    expect(calls).toBe(3);
    expect(readExtractionFailure(db, file)?.attempts).toBe(1);
  });

  it("a success clears the ledger and records the extraction", async () => {
    let calls = 0;
    const fake = makeFakeManager(async () => {
      calls++;
      if (calls === 1) {
        return "garbage";
      }
      return JSON.stringify({
        facts: [
          { text: "gateway is a2a.new.example", layer: "world_fact", confidence: 0.9, lines: [1] },
        ],
        handover: {
          purpose: "cutover",
          milestones: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
        },
      });
    });
    const file = writeSession("sess-ok", [
      ["user", "the gateway is a2a.new.example now, we cut over yesterday"],
      ["assistant", "noted"],
    ]);
    await runExtraction(fake);
    expect(readExtractionFailure(db, file)?.attempts).toBe(1);
    // Same content, attempt 2 succeeds.
    await runExtraction(fake);
    expect(calls).toBe(2);
    expect(readExtractionFailure(db, file)).toBeNull();
    const tracked = db
      .prepare(`SELECT fact_count FROM session_extractions WHERE session_path = ?`)
      .get(file) as { fact_count: number } | undefined;
    expect(tracked?.fact_count).toBe(1);
    // Parked-and-then-succeeded transcripts are not re-extracted next cycle.
    await runExtraction(fake);
    expect(calls).toBe(2);
  });
});
