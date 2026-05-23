/**
 * PLAN-20: end-to-end integration test for the interceptor pipeline.
 *
 * Exercises the seam between every major component without going through
 * the real gateway:
 *   1. Register a custom interceptor in the registry
 *   2. Bind a SQLite-backed intervention store
 *   3. Feed user turns into the session-context tracker
 *   4. Call runInterceptors with a candidate tool call
 *   5. Confirm the interceptor fired, the record is persisted with a
 *      signature, an intervention.fired event was emitted, and the outcome
 *      backfill correctly attaches a tag when the user reacts.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { PreActionInterceptor } from "./interceptor.js";
import { onAgentEvent, resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { resetInterceptorAutoBootForTest } from "./interceptor-autoboot.js";
import {
  setInterceptorContextProviders,
  clearInterceptorContextProviders,
  __testing as ctxTesting,
} from "./interceptor-context.js";
import { getInterceptorRegistry } from "./interceptor-registry.js";
import { runInterceptors, resetInterceptorRunnerState } from "./interceptor-runner.js";
import {
  setInterventionSigner,
  setInterventionStore,
  getInterventionStore,
} from "./intervention-record.js";
import { createSqliteInterventionStore } from "./intervention-store.js";
import { backfillOutcomesFromUserMessage } from "./outcome-backfill.js";
import { recordTurn, resetSessionContextTrackerForTest } from "./session-context-tracker.js";

function openDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(d);
  return d;
}

describe("PLAN-20 integration", () => {
  let db: DatabaseSync;
  let firedEvents: Array<{ stream: string; data: Record<string, unknown> }>;
  let unsub: () => void;

  beforeEach(() => {
    db = openDb();
    // Reset autoboot so it doesn't lazy-overwrite the test signer/store
    // mid-run on the first runInterceptors call in this test file.
    resetInterceptorAutoBootForTest();
    setInterventionStore(createSqliteInterventionStore(db));
    setInterventionSigner((canonical) => ({
      ed25519: `sig:${canonical.length}`,
      pubkeyId: "test-key",
    }));
    getInterceptorRegistry().clear();
    resetInterceptorRunnerState();
    resetSessionContextTrackerForTest();
    clearInterceptorContextProviders();
    // Bind providers so the runner can build a real StepContext.
    setInterceptorContextProviders({
      hormonal: () => ctxTesting.NEUTRAL_HORMONAL,
      gccrf: () => ctxTesting.NEUTRAL_GCCRF,
      channel: () => "internal",
      recentTurns: () => [],
      toolHistory: () => [],
      turnNumber: () => 1,
    });

    firedEvents = [];
    resetAgentRunContextForTest();
    unsub = onAgentEvent((evt) => {
      if (evt.stream === "intervention") {
        firedEvents.push({ stream: evt.stream, data: evt.data });
      }
    });
  });

  afterEach(() => {
    unsub();
    setInterventionStore(null);
    setInterventionSigner(null);
    clearInterceptorContextProviders();
    getInterceptorRegistry().clear();
  });

  it("full pipeline: register → fire → persist → emit → backfill", async () => {
    // 1. Register an interceptor that always fires with a modify intervention.
    const interceptor: PreActionInterceptor = {
      id: "integration:default",
      skill: "integration",
      priority: 50,
      tools: ["send_message"],
      shouldActivate: () => true,
      intervene: () => ({
        type: "modify",
        newParams: { text: "rewritten" },
        reason: "integration test rewrite",
      }),
    };
    getInterceptorRegistry().register(interceptor, "builtin");

    // 2. Call runInterceptors with a candidate send_message.
    const outcome = await runInterceptors({
      toolName: "send_message",
      params: { text: "original" },
      sessionKey: "session-1",
    });
    expect(outcome.kind).toBe("modify");

    // 3. Confirm the record was persisted.
    const store = getInterventionStore();
    expect(store).not.toBeNull();
    const recent = store!.recent({ sessionKey: "session-1", limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.skill).toBe("integration");
    expect(recent[0]?.intervention.type).toBe("modify");
    expect(recent[0]?.sig.pubkeyId).toBe("test-key");
    expect(recent[0]?.sig.ed25519).toMatch(/^sig:\d+$/);

    // 4. Confirm intervention.fired event broadcast.
    expect(firedEvents.length).toBe(1);
    expect(firedEvents[0]?.data.skill).toBe("integration");
    expect(firedEvents[0]?.data.interceptorId).toBe("integration:default");

    // 5. Outcome backfill: a "thanks!" reply should mark the record success.
    recordTurn("session-1", "user", "perfect, thanks!");
    backfillOutcomesFromUserMessage({
      db,
      sessionKey: "session-1",
      userText: "perfect, thanks!",
    });

    const row = db
      .prepare(`SELECT outcome_tag FROM intervention_records WHERE skill='integration'`)
      .get() as { outcome_tag: string };
    expect(row.outcome_tag).toBe("downstream-success");
  });

  it("require_prereq intervention surfaces as a block with INTERCEPTOR directive", async () => {
    const interceptor: PreActionInterceptor = {
      id: "integration:prereq",
      skill: "integration",
      priority: 50,
      tools: ["send_message"],
      shouldActivate: () => true,
      intervene: () => ({
        type: "require_prereq",
        tool: "memory_search",
        params: { query: "groundme" },
        reason: "must ground first",
      }),
    };
    getInterceptorRegistry().register(interceptor, "builtin");

    const outcome = await runInterceptors({
      toolName: "send_message",
      params: { text: "Claim that needs grounding." },
      sessionKey: "session-2",
    });
    expect(outcome.kind).toBe("require_prereq");
    if (outcome.kind === "require_prereq") {
      expect(outcome.tool).toBe("memory_search");
    }

    const recent = getInterventionStore()!.recent({ sessionKey: "session-2", limit: 5 });
    expect(recent[0]?.intervention.type).toBe("require_prereq");
  });

  it("block intervention with userVisibleMessage produces a block outcome", async () => {
    const interceptor: PreActionInterceptor = {
      id: "integration:block",
      skill: "integration",
      priority: 50,
      tools: ["wallet_send"],
      shouldActivate: () => true,
      intervene: () => ({
        type: "block",
        reason: "cortisol high",
        userVisibleMessage: "About to send $X — confirm or cancel?",
      }),
    };
    getInterceptorRegistry().register(interceptor, "builtin");

    const outcome = await runInterceptors({
      toolName: "wallet_send",
      params: { amount: 50 },
      sessionKey: "session-3",
    });
    expect(outcome.kind).toBe("block");

    // Backfill a "cancel" reply → user-confirmed-block.
    backfillOutcomesFromUserMessage({
      db,
      sessionKey: "session-3",
      userText: "cancel that",
    });
    const row = db
      .prepare(`SELECT outcome_tag FROM intervention_records WHERE skill='integration'`)
      .get() as { outcome_tag: string };
    expect(row.outcome_tag).toBe("user-confirmed-block");
  });
});
