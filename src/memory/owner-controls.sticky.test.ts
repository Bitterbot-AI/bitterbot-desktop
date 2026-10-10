/**
 * PLAN-55 Phase 0: "forgotten stays forgotten after re-extraction".
 *
 * Drives the real `runSessionExtraction` (the manager-wiring pattern from
 * manager.extraction-wiring.test.ts) against a real DB and a fixture LLM
 * that returns the same facts every time. The owner forgets the extracted
 * memory, retires the pinned fact and removes the learned preference; the
 * session then grows (new content hash) and extraction runs again. Nothing
 * the owner removed may come back, by any of the three regrowth paths.
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
import {
  chunkTextHash,
  isSuppressed,
  listSuppressions,
  normalizeLoose,
} from "./memory-suppressions.js";
import {
  deletePreference,
  editMemory,
  forgetMemory,
  listAuditLog,
  listPreferences,
  retireFact,
  unretireFact,
} from "./owner-controls.js";
import { UserModelManager } from "./user-model.js";

const AGENT_ID = "stickytest";
const FACT_TEXT = "The deploy endpoint is api.acme.com.";
const DIRECTIVE_TEXT = "Always reply in Spanish.";
const KEY = "infra.deploy_endpoint";
const TABLES = { ftsTable: null, vectorTable: null };

describe("forgotten stays forgotten after re-extraction (PLAN-55 Phase 0)", () => {
  let stateDir: string;
  let workspaceDir: string;
  let savedStateDir: string | undefined;
  let db: DatabaseSync;
  let store: CanonicalFactsStore;
  let userModel: UserModelManager;
  let llmCalls: number;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticky-state-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticky-ws-"));
    savedStateDir = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    store = new CanonicalFactsStore(db);
    userModel = new UserModelManager(db);
    llmCalls = 0;
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

  function writeSession(userLines: string[]): void {
    const sessionsDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const records = userLines.flatMap((line) => [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      },
      { type: "message", message: { role: "user", content: [{ type: "text", text: line }] } },
    ]);
    fs.writeFileSync(
      path.join(sessionsDir, "sess-owner.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ [`agent:${AGENT_ID}`]: { sessionId: "sess-owner" } }),
    );
  }

  async function runExtraction(
    texts: { fact: string; directive: string; extra?: string } = {
      fact: FACT_TEXT,
      directive: DIRECTIVE_TEXT,
    },
  ): Promise<void> {
    const llmCall = async () => {
      llmCalls += 1;
      return JSON.stringify({
        facts: [
          {
            text: texts.fact,
            layer: "world_fact",
            confidence: 0.9,
            lines: [2],
            canonicalKey: KEY,
            canonicalValue: "api.acme.com",
          },
          { text: texts.directive, layer: "directive", confidence: 0.9, lines: [2] },
          ...(texts.extra
            ? [{ text: texts.extra, layer: "world_fact", confidence: 0.9, lines: [2] }]
            : []),
        ],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    };
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
      epistemicDirectiveEngine: new EpistemicDirectiveEngine(db),
      canonicalFactsStore: store,
      userModelManager: userModel,
      knowledgeGraph: null,
      workspaceDir,
    };
    const proto = MemoryIndexManager.prototype as unknown as {
      runSessionExtraction(this: unknown): Promise<void>;
    };
    await proto.runSessionExtraction.call(fake);
  }

  const factChunks = () =>
    db.prepare(`SELECT id, text FROM chunks WHERE id LIKE 'fact_%'`).all() as unknown as Array<{
      id: string;
      text: string;
    }>;
  const directivePref = () =>
    listPreferences(db).find((p) => p.category === "directive" && /spanish/.test(p.key));

  it("does not regrow the forgotten memory, the retired fact or the removed preference", async () => {
    writeSession(["the deploy endpoint is api.acme.com, and always reply in Spanish"]);
    await runExtraction();
    expect(llmCalls).toBe(1);

    // Everything landed the first time.
    const chunks = factChunks();
    const factChunk = chunks.find((c) => c.text === FACT_TEXT);
    const directiveChunk = chunks.find((c) => c.text === DIRECTIVE_TEXT);
    expect(factChunk).toBeDefined();
    expect(directiveChunk).toBeDefined();
    expect(store.get(KEY)?.value).toBe("api.acme.com");
    expect(store.get(KEY)?.status).toBe("active");
    const pref = directivePref();
    expect(pref).toBeDefined();

    // The owner removes all of it.
    forgetMemory(db, factChunk!.id, TABLES);
    forgetMemory(db, directiveChunk!.id, TABLES);
    expect(retireFact(db, store, KEY)).toBe(true);
    expect(deletePreference(db, pref!.category, pref!.key)).toBe(true);
    expect(store.get(KEY)?.status).toBe("owner_retired");
    expect(
      listSuppressions(db)
        .map((s) => s.kind)
        .toSorted(),
    ).toEqual(["chunk_hash", "chunk_hash", "fact_key_value", "preference_key", "preference_value"]);
    expect(listAuditLog(db).map((e) => e.event)).toEqual(
      expect.arrayContaining(["owner_forget", "owner_retire_fact", "owner_forget_preference"]),
    );

    // The session grows: new content hash, extraction runs again and the
    // model says the same things, with the punctuation, case and spacing
    // drift a real extractor shows between runs, plus one materially new
    // fact that IS allowed to land.
    writeSession([
      "the deploy endpoint is api.acme.com, and always reply in Spanish",
      "also, we moved the standup to 10am, which is a longer line so the delta is real",
    ]);
    const EXTRA = "The staging endpoint is staging.acme.com.";
    await runExtraction({
      fact: "the deploy endpoint is API.acme.com",
      directive: "ALWAYS  reply in Spanish",
      extra: EXTRA,
    });
    expect(llmCalls).toBe(2);

    // Nothing the owner removed came back; the new fact did.
    const texts = factChunks().map((c) => normalizeLoose(c.text));
    expect(texts).not.toContain(normalizeLoose(FACT_TEXT));
    expect(texts).not.toContain(normalizeLoose(DIRECTIVE_TEXT));
    expect(texts).toContain(normalizeLoose(EXTRA));
    expect(store.get(KEY)?.status).toBe("owner_retired");
    expect(store.get(KEY)?.mentionCount).toBe(1);
    expect(directivePref()).toBeUndefined();
    expect(listPreferences(db)).toHaveLength(0);
  });

  it("a different value for the retired key supersedes it without a question for the owner", async () => {
    // The live-data case: an agent_pin row the owner retires must not lock
    // the key; extraction proposing a NEW value supersedes, and the sweep
    // never offers the retired value back as "which is current?".
    store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" });
    expect(retireFact(db, store, KEY)).toBe(true);
    const result = store.pin({ key: KEY, value: "api2.acme.com", source: "extraction" });
    expect(result.op).toBe("supersede");
    expect(store.get(KEY)?.value).toBe("api2.acme.com");
    expect(store.get(KEY)?.status).toBe("active");
    const conflicts = db.prepare(`SELECT kind FROM canonical_conflicts WHERE key = ?`).all(KEY);
    expect(conflicts).toEqual([]);
    const engine = new EpistemicDirectiveEngine(db);
    expect(engine.sweepCanonicalConflicts()).toBe(0);
    expect(engine.listOpenDirectives(10)).toHaveLength(0);
    // The retired value itself is still out.
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }).op).toBe(
      "rejected",
    );
  });

  it("forget after an edit suppresses the original text as well as the edited one", async () => {
    writeSession(["the deploy endpoint is api.acme.com, and always reply in Spanish"]);
    await runExtraction();
    const factChunk = factChunks().find((c) => c.text === FACT_TEXT)!;
    editMemory(db, factChunk.id, "The deploy endpoint is api.acme.com (owner-edited).", TABLES);
    forgetMemory(db, factChunk.id, TABLES);
    expect(isSuppressed(db, "chunk_hash", chunkTextHash(FACT_TEXT))).not.toBeNull();
    expect(
      isSuppressed(
        db,
        "chunk_hash",
        chunkTextHash("The deploy endpoint is api.acme.com (owner-edited)."),
      ),
    ).not.toBeNull();
    // The audit log carries the hash of what was edited away, never the text.
    const meta = db
      .prepare(`SELECT metadata FROM memory_audit_log WHERE event = 'owner_edit'`)
      .get() as { metadata: string };
    expect(meta.metadata).toContain(chunkTextHash(FACT_TEXT));
    expect(meta.metadata).not.toContain("api.acme.com");

    writeSession([
      "the deploy endpoint is api.acme.com, and always reply in Spanish",
      "second line to move the content hash a reasonable distance",
    ]);
    await runExtraction();
    expect(factChunks().map((c) => normalizeLoose(c.text))).not.toContain(
      normalizeLoose(FACT_TEXT),
    );
  });

  it("an owner write that cannot record its suppression does not happen at all", async () => {
    writeSession(["the deploy endpoint is api.acme.com, and always reply in Spanish"]);
    await runExtraction();
    const factChunk = factChunks().find((c) => c.text === FACT_TEXT)!;
    const pref = directivePref()!;
    db.exec(`DROP TABLE memory_suppressions`);

    expect(() => retireFact(db, store, KEY)).toThrow();
    expect(store.get(KEY)?.status).toBe("active");
    expect(() => forgetMemory(db, factChunk.id, TABLES)).toThrow();
    expect(factChunks().some((c) => c.id === factChunk.id)).toBe(true);
    expect(() => deletePreference(db, pref.category, pref.key)).toThrow();
    expect(directivePref()).toBeDefined();
    expect(listAuditLog(db).map((e) => e.event)).not.toEqual(
      expect.arrayContaining(["owner_forget", "owner_retire_fact", "owner_forget_preference"]),
    );
  });

  it("unretire lets the fact corroborate again while the forgotten memory stays forgotten", async () => {
    writeSession(["the deploy endpoint is api.acme.com, and always reply in Spanish"]);
    await runExtraction();
    const factChunk = factChunks().find((c) => c.text === FACT_TEXT)!;
    forgetMemory(db, factChunk.id, TABLES);
    retireFact(db, store, KEY);
    expect(unretireFact(db, store, KEY)).toBe(true);
    expect(store.get(KEY)?.status).toBe("active");

    writeSession([
      "the deploy endpoint is api.acme.com, and always reply in Spanish",
      "second line to move the content hash a reasonable distance",
    ]);
    await runExtraction();
    expect(factChunks().filter((c) => c.text === FACT_TEXT)).toHaveLength(0);
    // The fact chunk was skipped, so the pin that rides on it was skipped too:
    // the ledger row is untouched rather than re-pinned without evidence.
    expect(store.get(KEY)?.status).toBe("active");
    expect(listSuppressions(db, { kind: "fact_key_value" })).toHaveLength(0);
  });
});

describe("a removed preference does not regrow from preference extraction", () => {
  let db: DatabaseSync;
  let userModel: UserModelManager;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    userModel = new UserModelManager(db);
  });

  it("extractPreferences skips the suppressed key", () => {
    expect(userModel.extractPreferences("I prefer typescript for everything", "c1")).toHaveLength(
      1,
    );
    expect(listPreferences(db)).toHaveLength(1);
    expect(deletePreference(db, "language", "preferred_language")).toBe(true);
    expect(userModel.extractPreferences("I prefer TypeScript for everything", "c2")).toEqual([]);
    expect(listPreferences(db)).toHaveLength(0);
    // Another key is unaffected.
    expect(userModel.extractPreferences("I use pnpm here", "c3")).toHaveLength(1);
  });

  it("upsertFromDirective skips the suppressed key", () => {
    const first = userModel.upsertFromDirective({
      text: "Always reply in Spanish.",
      confidence: 0.9,
      sessionId: "s1",
    });
    expect(first).not.toBeNull();
    expect(deletePreference(db, first!.category, first!.key)).toBe(true);
    expect(
      userModel.upsertFromDirective({
        text: "Always reply in Spanish.",
        confidence: 0.9,
        sessionId: "s2",
      }),
    ).toBeNull();
    expect(listPreferences(db)).toHaveLength(0);
  });

  it("upsertFromDirective skips a reworded restatement of a removed directive", () => {
    const first = userModel.upsertFromDirective({
      text: "Always reply in Spanish.",
      confidence: 0.9,
      sessionId: "s1",
    });
    expect(first?.key).toBe("always_reply_spanish");
    expect(deletePreference(db, first!.category, first!.key)).toBe(true);
    // Different key (reply_spanish_always), same instruction: the writer
    // would have merged it into the removed row, so it must not mint a new one.
    expect(
      userModel.upsertFromDirective({
        text: "Reply in Spanish, always.",
        confidence: 0.9,
        sessionId: "s2",
      }),
    ).toBeNull();
    expect(listPreferences(db)).toHaveLength(0);
    // An unrelated directive still lands.
    expect(
      userModel.upsertFromDirective({
        text: "Never deploy on Fridays.",
        confidence: 0.9,
        sessionId: "s3",
      }),
    ).not.toBeNull();
  });

  it("extractPreferences skips a removed value under another key's category too", () => {
    expect(userModel.extractPreferences("I prefer typescript for everything", "c1")).toHaveLength(
      1,
    );
    expect(deletePreference(db, "language", "preferred_language")).toBe(true);
    expect(
      listSuppressions(db)
        .map((s) => s.kind)
        .toSorted(),
    ).toEqual(["preference_key", "preference_value"]);
    expect(userModel.extractPreferences("I always use TypeScript", "c2")).toEqual([]);
  });
});
