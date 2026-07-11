/**
 * PLAN-34 Phase 1 — MANAGER WIRING test (adversarial-pass finding: the
 * factored functions were unit-tested but nothing exercised
 * runSessionExtraction itself, this codebase's recurring wired-but-dead
 * failure class). Drives the real private method against a real DB, real
 * transcript files under a temp BITTERBOT_STATE_DIR, a real trust store,
 * and a fixture LLM that reads the open question out of its own prompt —
 * so the sweep -> offer -> parse -> answer -> pin -> finalize chain runs
 * through the exact production glue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const AGENT_ID = "wiretest";

describe("runSessionExtraction wiring (PLAN-34 Phase 1)", () => {
  let stateDir: string;
  let workspaceDir: string;
  let savedStateDir: string | undefined;
  let db: DatabaseSync;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-wire-state-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-wire-ws-"));
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

  function writeSession(sessionId: string, sessionKey: string, userLine: string): void {
    const sessionsDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const records = [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Quick check on a fact." }] },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: userLine }] },
      },
    ];
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ [sessionKey]: { sessionId } }),
    );
  }

  function makeFakeManager(llmCall: (prompt: string) => Promise<string>) {
    const engine = new EpistemicDirectiveEngine(db);
    const store = new CanonicalFactsStore(db);
    const fake = {
      cfg: {
        memory: {
          extraction: { minSessionDelta: 10 },
          architectEvolution: { enabled: false },
        },
      },
      agentId: AGENT_ID,
      db,
      dreamLlmCall: llmCall,
      hormonalManager: null,
      epistemicDirectiveEngine: engine,
      canonicalFactsStore: store,
      userModelManager: null,
      knowledgeGraph: null,
      workspaceDir,
    };
    return { fake, engine, store };
  }

  async function runExtraction(fake: unknown): Promise<void> {
    const proto = MemoryIndexManager.prototype as unknown as {
      runSessionExtraction(this: unknown): Promise<void>;
    };
    await proto.runSessionExtraction.call(fake);
  }

  it("closes the loop through the real manager glue: sweep -> offer -> answer -> pin -> finalize", async () => {
    // The LLM fixture reads the open-question id from its own prompt —
    // proving the Open Questions block actually reached the extractor.
    const prompts: string[] = [];
    const llmCall = async (prompt: string) => {
      prompts.push(prompt);
      const m = prompt.match(/- ([0-9a-f-]{36}): Which is current for infra\.gateway/);
      return JSON.stringify({
        facts: [],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
        ...(m
          ? {
              resolutions: [
                {
                  id: m[1],
                  answer: "a2a.new.example",
                  selectedValue: "a2a.new.example",
                  lines: [2],
                  confidence: 0.9,
                },
              ],
            }
          : {}),
      });
    };
    const { fake, engine, store } = makeFakeManager(llmCall);

    // Fuel: an equal-tier rapid flip records a conflict.
    store.pin({ key: "infra.gateway", value: "a2a.old.example", source: "extraction" });
    store.pin({ key: "infra.gateway", value: "a2a.old.example", source: "extraction" });
    store.pin({ key: "infra.gateway", value: "a2a.new.example", source: "extraction" });

    writeSession(
      "sess-owner-1",
      `agent:${AGENT_ID}`,
      "the gateway is a2a.new.example now, we cut over yesterday",
    );

    // Cycle 1: sweep creates the question, the extractor answers it.
    await runExtraction(fake);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("## Open Questions");

    const answered = engine
      .listOpenDirectives(5)
      .concat()
      .find(() => true);
    expect(answered).toBeUndefined(); // no longer open
    const row = db
      .prepare(`SELECT status, resolution, resolved_at FROM epistemic_directives`)
      .get() as { status: string; resolution: string; resolved_at: number | null };
    expect(row.status).toBe("answered");
    expect(row.resolution).toBe("a2a.new.example");
    expect(row.resolved_at).toBeNull();

    // The answer crystal exists with evidence, and the ledger corroborated.
    const crystal = db
      .prepare(
        `SELECT text FROM chunks WHERE epistemic_layer = 'world_fact' AND text LIKE '%a2a.new.example%'`,
      )
      .get();
    expect(crystal).toBeDefined();
    expect(store.get("infra.gateway")!.value).toBe("a2a.new.example");

    // Cycle 2 (no changed sessions): finalize resolves the survivor.
    await runExtraction(fake);
    const after = db.prepare(`SELECT resolved_at FROM epistemic_directives`).get() as {
      resolved_at: number | null;
    };
    expect(after.resolved_at).not.toBeNull();
  });

  it("never offers open questions to non-first-party sessions", async () => {
    const prompts: string[] = [];
    const llmCall = async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({
        facts: [],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    };
    const { fake, engine } = makeFakeManager(llmCall);
    engine.createDirective({ type: "knowledge_gap", question: "What DB do you use?" });

    // A subagent-authored transcript: trust classifies as untrusted.
    writeSession("sess-sub-1", `agent:${AGENT_ID}:subagent:x1`, "the db is postgres 16");

    await runExtraction(fake);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("## Open Questions");
  });

  it("stamps chunks.session_trust at extraction write time (PLAN-34 Phase 4)", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [
          { text: "The DB is Postgres 16.", layer: "world_fact", confidence: 0.9, lines: [2] },
        ],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    const { fake } = makeFakeManager(llmCall);

    // First-party owner session and an untrusted subagent session.
    writeSession("sess-fp", `agent:${AGENT_ID}`, "we run Postgres 16 in prod");
    await runExtraction(fake);
    const fp = db
      .prepare(`SELECT session_trust FROM chunks WHERE epistemic_layer = 'world_fact' LIMIT 1`)
      .get() as { session_trust: string } | undefined;
    expect(fp?.session_trust).toBe("first_party");
  });

  it("backfills session_trust for pre-migration NULL chunks during extraction (PLAN-34 §6.2)", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    const { fake } = makeFakeManager(llmCall);
    // The fake is a plain object; give it the real step-A method + flag so
    // runSessionExtraction's `this.backfillSessionTrust()` resolves.
    (fake as Record<string, unknown>).sessionTrustBackfillDone = false;
    (fake as Record<string, unknown>).backfillSessionTrust = (
      MemoryIndexManager.prototype as unknown as { backfillSessionTrust: () => Promise<number> }
    ).backfillSessionTrust;

    // A real first-party session so the trust store loads a mapping…
    writeSession("sess-owner", `agent:${AGENT_ID}`, "hello there");
    const sessionsDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
    // …plus a PRE-MIGRATION session chunk written before the v34 column
    // existed: session_trust is NULL and its path is the owner transcript.
    const now = Date.now();
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         session_trust, created_at, updated_at)
       VALUES ('legacy1', ?, 'sessions', 0, 0, 'legacy fact', 'h_legacy', 'test', '[]', NULL, ?, ?)`,
    ).run(path.join(sessionsDir, "sess-owner.jsonl"), now, now);
    // …and an orphaned session chunk whose path is not in the store.
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         session_trust, created_at, updated_at)
       VALUES ('legacy2', '/gone/orphan.jsonl', 'sessions', 0, 0, 'orphan', 'h_orphan', 'test', '[]', NULL, ?, ?)`,
    ).run(now, now);

    await runExtraction(fake);

    const mapped = db.prepare(`SELECT session_trust FROM chunks WHERE id = 'legacy1'`).get() as {
      session_trust: string | null;
    };
    const orphan = db.prepare(`SELECT session_trust FROM chunks WHERE id = 'legacy2'`).get() as {
      session_trust: string | null;
    };
    expect(mapped.session_trust).toBe("first_party"); // resolved via the store
    expect(orphan.session_trust).toBe("unknown"); // unmapped → stamped, not left NULL
  });
});
