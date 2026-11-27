/**
 * PLAN-64 Phase 1b: the per-turn note for a practice offer the owner just
 * answered, carried by the practices block resolver.
 *
 * Under test, through resolvePracticesBlock with the memory manager
 * replaced by the real stores: a bare "yes" to a pending offer is applied
 * before the block is built (so the new practice renders when its scope
 * matches), the note is appended whether or not any practice renders, a
 * turn that is not the owner's or a message that is not a bare answer gets
 * no note and changes nothing, and the offers switch.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { answerPracticeOffer } from "../memory/owner-controls.js";
import {
  type FollowUpTurnDeps,
  resolveOfferAnswerBeforeRun,
} from "../memory/practice-followup-turn.js";
import { FollowUpStateStore, recordGapSighting } from "../memory/practice-followups.js";
import { PracticesStore } from "../memory/practices.js";
import { observeOwnerTurn, TaskTypesStore } from "../memory/task-types.js";

const state = vi.hoisted(() => ({ manager: null as unknown }));

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: { get: async () => state.manager },
}));

import { PRACTICES_BLOCK_HEADER, resolvePracticesBlock } from "./practices-block.js";

const SESSION = "agent:main:main";
const STATS = "How many clones did your repo get yesterday?";

let practices: PracticesStore;
let followUpState: FollowUpStateStore;
let candidateId: string;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  practices = new PracticesStore(db);
  followUpState = new FollowUpStateStore(db);
  const taskTypes = new TaskTypesStore(db);
  taskTypes.adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: [STATS],
    occurrences: 3,
    distinctDays: 3,
    firstSeen: 0,
    lastSeen: 0,
    recurring: true,
  });
  const deps: FollowUpTurnDeps = {
    practices,
    taskTypes,
    state: followUpState,
    change: async (_label, fn) => fn(),
    answerOffer: async (id, answer) => answerPracticeOffer(db, practices, id, answer),
  };
  state.manager = {
    practices: () => practices,
    observeOwnerTurnTaskType: (params: { text: string }) =>
      observeOwnerTurn(taskTypes, params, null),
    // What MemoryIndexManager.resolvePracticeOfferNote does.
    resolvePracticeOfferNote: (params: { sessionKey?: string; text: string; runId?: string }) =>
      resolveOfferAnswerBeforeRun(deps, { cfg: {}, ...params }),
  };
  const sighted = recordGapSighting({
    store: practices,
    taskSlug: "repo-stats",
    statement: "Include npm downloads",
    ownerProse: "how about our npm downloads",
    evidenceRef: null,
    sessionId: "s1",
    explicit: false,
    origin: "follow_up",
  });
  if (sighted.kind !== "candidate") {
    throw new Error("seed failed");
  }
  candidateId = sighted.practice.id;
  practices.recordOffer(candidateId, { sessionId: "s1" });
  followUpState.setOffer(SESSION, candidateId, { sessionId: "s1" });
});

const turn = (over: Record<string, unknown> = {}) => ({
  agentId: "main",
  config: {},
  sessionKey: SESSION,
  senderIsOwner: true,
  isHeartbeat: false,
  promptMode: "full" as const,
  prompt: "[Fri 2026-11-27 09:20 EST] yes",
  runId: "run-yes",
  ...over,
});

describe("resolvePracticesBlock: the offer-answer note", () => {
  it("a bare yes is applied and the agent is told what it answered", async () => {
    const block = await resolvePracticesBlock(turn());
    expect(block).toContain("## Practice offer answered");
    expect(block).toContain('"Include npm downloads"');
    expect(block).toContain("repo stats");
    expect(block).toContain("The owner said yes");
    // "yes" is not a repo-stats turn, so no practice renders: the note stands alone.
    expect(block).not.toContain(PRACTICES_BLOCK_HEADER[0]);
    expect(practices.get(candidateId)).toMatchObject({ status: "active", source: "owner" });
    // A retried attempt of the run gets the same note.
    expect(await resolvePracticesBlock(turn())).toBe(block);
  });

  it("a bare no is applied and noted", async () => {
    const block = await resolvePracticesBlock(turn({ prompt: "no thanks" }));
    expect(block).toContain("The owner said no");
    expect(practices.get(candidateId)?.status).toBe("suppressed");
  });

  it("a repo-stats turn that is not an answer gets no note and leaves the candidate alone", async () => {
    const block = await resolvePracticesBlock(turn({ prompt: STATS, runId: "run-2" }));
    expect(block).toBeUndefined();
    expect(practices.get(candidateId)?.status).toBe("candidate");
  });

  it("the note follows the practices block when practices render", async () => {
    practices.upsert({ statement: "Keep answers short.", source: "owner" });
    const block = await resolvePracticesBlock(turn());
    expect(block).toContain(PRACTICES_BLOCK_HEADER[0]);
    expect(block!.indexOf("## Practice offer answered")).toBeGreaterThan(
      block!.indexOf("Keep answers short."),
    );
  });

  it("nobody but the owner on a first-party turn can answer an offer", async () => {
    for (const over of [
      { senderIsOwner: false },
      { guestTurn: true },
      { isHeartbeat: true },
      { sessionKey: "agent:main:telegram:group:123" },
      { sessionKey: "agent:main:subagent:abc" },
      { sessionKey: "agent:main:cron:job-7" },
      { config: { memory: { practices: { enabled: false } } } },
      { config: { memory: { practices: { offers: { enabled: false } } } } },
    ]) {
      expect(await resolvePracticesBlock(turn(over)), JSON.stringify(over)).toBeUndefined();
      expect(practices.get(candidateId)?.status, JSON.stringify(over)).toBe("candidate");
    }
  });
});
