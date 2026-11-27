/**
 * PLAN-64 Phase 5: scheduled jobs that learn from the owner's corrections,
 * on the real stores with canned model output.
 *
 * Under test: the announcement record and the job link (next owner message
 * only, the six hour window, a restart in between, most recent wins against
 * a recurring-task answer); an explicit instruction saved at `job:` scope
 * and rendered in that job's own session only; the follow-up gap as a
 * candidate and an offer at job scope; the canary line (once, "and N more");
 * rollback on a repeated or a contradicting correction, and what does not
 * roll back; the experience file and its deletion.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPracticesBlock, type PracticesBlockManager } from "../agents/practices-block.js";
import type { BitterbotConfig } from "../config/config.js";
import { buildJobPromptSection, runCorrectionCapture } from "./correction-capture.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  answerPracticeOffer,
  listAuditLog,
  rollbackPractice,
  savePractice,
} from "./owner-controls.js";
import {
  beginFollowUpTurn,
  finishFollowUpTurn,
  type FollowUpTurnDeps,
  resolveOfferAnswerBeforeRun,
} from "./practice-followup-turn.js";
import { FollowUpStateStore } from "./practice-followups.js";
import {
  removeJobExperience,
  renderJobExperience,
  resolveJobExperiencePath,
  syncJobExperienceFiles,
} from "./practice-job-experience.js";
import {
  commitJobAnnouncement,
  formatCanaryLine,
  formatRollbackLine,
  JOB_LINK_WINDOW_MS,
  JobAnnouncementStore,
  type JobLink,
  jobReportLabel,
  prepareJobRun,
  takeJobLink,
} from "./practice-jobs.js";
import { PracticesStore } from "./practices.js";
import { TaskTypesStore } from "./task-types.js";

const MAIN = "agent:main:main";
const JOB = "cron_traffic1";
const JOB_NAME = "Repo traffic";
const JOB_MESSAGE = "Report yesterday's clone and view counts for the repo.";
const REPORT = "Yesterday the repo had 240 clones and 1,310 views.";
const REPORT_WITH_UNIQUES =
  "Yesterday the repo had 240 clones (68 unique) and 1,310 views (402 unique). Unique counts are included.";
const UNIQUES = "Include the unique counts";
const ASK_UNIQUES = "give me the unique counts too every time";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
const TZ = "UTC";

type Harness = {
  db: DatabaseSync;
  practices: PracticesStore;
  taskTypes: TaskTypesStore;
  state: FollowUpStateStore;
  announcements: JobAnnouncementStore;
  deps: FollowUpTurnDeps;
};

function open(file = ":memory:"): Harness {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  const practices = new PracticesStore(db);
  const state = new FollowUpStateStore(db);
  const taskTypes = new TaskTypesStore(db);
  return {
    db,
    practices,
    taskTypes,
    state,
    announcements: new JobAnnouncementStore(db),
    deps: {
      practices,
      taskTypes,
      state,
      change: async (_label, fn) => fn(),
      answerOffer: async (id, answer) => answerPracticeOffer(db, practices, id, answer),
      jobName: (id) => (id === JOB ? JOB_NAME : undefined),
      rollback: async (id, detail) => rollbackPractice(db, practices, id, detail),
    },
  };
}

let h: Harness;
let dir: string;
const llm = vi.fn<(prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>>();

const at = (ts: number) => vi.setSystemTime(ts);

/** The cron side of a run: the job's prompt is built, the report is announced. */
function runJob(
  params: { jobId?: string; reply?: string; startedAt: number; sessionKey?: string } = {
    startedAt: T0,
  },
) {
  const jobId = params.jobId ?? JOB;
  at(params.startedAt);
  const block = buildPracticesBlock(blockManager(), {
    config: {},
    sessionKey: `agent:main:cron:${jobId}`,
    promptMode: "full",
    prompt: `[cron:${jobId} ${JOB_NAME}] ${JOB_MESSAGE}`,
    runId: `run-${jobId}-${params.startedAt}`,
  });
  at(params.startedAt + MIN);
  const reply = params.reply ?? REPORT;
  const canary = prepareJobRun(h.practices, {
    jobId,
    reply,
    runStartedAt: params.startedAt,
    timeZone: TZ,
  });
  const announcement = commitJobAnnouncement(
    { announcements: h.announcements, practices: h.practices },
    {
      jobId,
      jobName: JOB_NAME,
      sessionKey: params.sessionKey ?? MAIN,
      destination: "main",
      requestText: JOB_MESSAGE,
      outputText: reply,
      canary,
    },
  );
  return { block, canary, announcement };
}

function blockManager(): PracticesBlockManager {
  return {
    practices: () => h.practices,
    taskTypes: () => h.taskTypes,
    observeOwnerTurnTaskType: ({ text }) => {
      const type = h.taskTypes.classify(text);
      return type?.recurring ? { slug: type.slug, label: type.label } : null;
    },
  };
}

const takeLink = (now: number, sessionKey = MAIN): JobLink | null =>
  takeJobLink(
    { announcements: h.announcements, practices: h.practices },
    { sessionKey, lastAnswerAt: h.state.get(sessionKey)?.answeredAt ?? null, now },
  );

/** One owner turn in the main conversation through the reply path. */
async function ownerTurn(params: {
  text: string;
  now: number;
  reply?: string;
  cfg?: BitterbotConfig;
  runId?: string;
}) {
  at(params.now);
  const cfg = params.cfg ?? {};
  const reply = params.reply ?? "Done.";
  const note = await resolveOfferAnswerBeforeRun(h.deps, {
    cfg,
    sessionKey: MAIN,
    text: params.text,
    runId: params.runId,
    now: params.now,
  });
  const jobLink = takeLink(params.now);
  const turn = await beginFollowUpTurn(h.deps, {
    cfg,
    sessionKey: MAIN,
    sessionId: "s1",
    userMessage: params.text,
    jobLink,
    now: params.now,
  });
  const type = h.taskTypes.classify(params.text);
  const capture = await runCorrectionCapture({
    cfg,
    sessionKey: MAIN,
    userMessage: params.text,
    assistantReply: reply,
    senderIsOwner: true,
    isHeartbeat: false,
    chatType: "direct",
    runStartedAt: params.now,
    store: null,
    job: jobLink,
    practices: {
      save: async (input) => savePractice(h.db, h.practices, input),
      store: h.practices,
      taskType: type?.recurring ? { slug: type.slug, label: type.label } : null,
      ...(jobLink
        ? {
            cronJobId: jobLink.jobId,
            rollback: async (id, detail) => rollbackPractice(h.db, h.practices, id, detail),
          }
        : {}),
    },
    followUp: turn.gapContext,
    pinAsOwner: null,
    llmCall: llm,
    now: params.now,
  });
  const finished = await finishFollowUpTurn(h.deps, turn, {
    cfg,
    sessionKey: MAIN,
    sessionId: "s1",
    userMessage: params.text,
    replyText: reply,
    chatType: "direct",
    followUp: capture.followUp,
    captured: capture.practices,
    jobLink,
    now: params.now,
  });
  await finished.confirmOffer?.(params.now);
  return { note, jobLink, turn, capture, finished };
}

const practicesJson = (practices: Array<Record<string, unknown>>, followUp?: unknown) =>
  JSON.stringify({ facts: [], practices, ...(followUp ? { follow_up: followUp } : {}) });
const SAVE_UNIQUES = practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }], {
  kind: "other",
});

function seedRepoStats(): void {
  h.taskTypes.adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: [
      "How many clones did your repo get yesterday?",
      "how did our npm's and clones do yesterday?",
    ],
    occurrences: 3,
    distinctDays: 3,
    firstSeen: T0 - 10 * DAY,
    lastSeen: T0 - DAY,
    recurring: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  at(T0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-practice-jobs-"));
  h = open();
  llm.mockReset();
  llm.mockResolvedValue(JSON.stringify({ kind: "other" }));
});

afterEach(() => {
  vi.useRealTimers();
  try {
    h.db.close();
  } catch {
    // already closed
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 83 and the announcement record", () => {
  it("creates the table and records which job was announced where and when", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
    const { announcement } = runJob({ startedAt: T0 });
    expect(announcement).toMatchObject({
      jobId: JOB,
      jobName: JOB_NAME,
      sessionKey: MAIN,
      destination: "main",
      requestText: JOB_MESSAGE,
      outputText: REPORT,
      canaryPracticeIds: [],
      announcedAt: T0 + MIN,
      consumedAt: null,
    });
    expect(h.announcements.listForJob(JOB)).toHaveLength(1);
  });

  it("never throws on a database without the table", () => {
    const bare = new JobAnnouncementStore(new DatabaseSync(":memory:"));
    expect(
      bare.record({ jobId: JOB, sessionKey: MAIN, requestText: "x", outputText: "y" }),
    ).toBeNull();
    expect(bare.pending(MAIN)).toBeNull();
    expect(bare.consume(MAIN)).toBe(0);
    expect(bare.listForJob(JOB)).toEqual([]);
  });
});

describe("the job link", () => {
  it("is taken by the owner's next message and by no message after it", () => {
    runJob({ startedAt: T0 });
    const link = takeLink(T0 + 10 * MIN);
    expect(link).toMatchObject({
      jobId: JOB,
      scope: `job:${JOB}`,
      jobName: JOB_NAME,
      label: "the Repo traffic report",
      requestText: JOB_MESSAGE,
      outputText: REPORT,
      canaries: [],
    });
    expect(takeLink(T0 + 11 * MIN)).toBeNull();
    expect(h.announcements.latest(MAIN)?.consumedAt).toBe(T0 + 10 * MIN);
  });

  it("belongs to the conversation the report was announced in", () => {
    runJob({ startedAt: T0 });
    expect(takeLink(T0 + 10 * MIN, "agent:main:telegram:direct:42")).toBeNull();
    expect(takeLink(T0 + 11 * MIN)).not.toBeNull();
  });

  it("expires after six hours, and the late message still consumes it", () => {
    runJob({ startedAt: T0 });
    const late = T0 + MIN + JOB_LINK_WINDOW_MS + 1;
    expect(takeLink(late)).toBeNull();
    expect(h.announcements.latest(MAIN)?.consumedAt).toBe(late);
    // At the edge of the window it still links.
    runJob({ startedAt: T0 + DAY });
    expect(takeLink(T0 + DAY + MIN + JOB_LINK_WINDOW_MS)).not.toBeNull();
  });

  it("only the most recent announcement can link, and an owner turn in between closes it", () => {
    runJob({ startedAt: T0 });
    runJob({ jobId: "cron_other", startedAt: T0 + 30 * MIN });
    expect(takeLink(T0 + 40 * MIN)?.jobId).toBe("cron_other");
    expect(takeLink(T0 + 41 * MIN)).toBeNull();
    // Both rows are consumed: the older one never links later.
    expect(h.announcements.listForJob(JOB)[0]?.consumedAt).toBe(T0 + 40 * MIN);
  });

  it("survives a gateway restart between the report and the owner's reply", () => {
    const file = path.join(dir, "memory.sqlite");
    h.db.close();
    h = open(file);
    runJob({ startedAt: T0 });
    h.db.close();
    h = open(file);
    expect(takeLink(T0 + 2 * HOUR)).toMatchObject({ jobId: JOB, outputText: REPORT });
    h.db.close();
    h = open(file);
    expect(takeLink(T0 + 2 * HOUR + MIN)).toBeNull();
  });

  it("most recent wins: an answer to a later owner turn beats the announcement", async () => {
    seedRepoStats();
    runJob({ startedAt: T0 });
    // An owner turn was answered after the report without the link being
    // taken (for example while the switch was off): that answer is newer.
    h.state.recordAnswer(MAIN, {
      sessionId: "s1",
      taskSlug: "repo-stats",
      ownerText: "How many clones did your repo get yesterday?",
      answerText: "68 unique clones.",
      now: T0 + 20 * MIN,
    });
    llm.mockResolvedValue(JSON.stringify({ kind: "gap", missing: "Include npm downloads" }));
    const res = await ownerTurn({ text: "how about our npm downloads", now: T0 + 30 * MIN });
    expect(res.jobLink).toBeNull();
    expect(res.turn.gapContext).toMatchObject({ taskSlug: "repo-stats" });
    expect(res.finished.sighting).toMatchObject({ kind: "candidate" });
    expect(h.practices.list({ scope: "task:repo-stats" })).toHaveLength(1);
    expect(h.practices.list({ scope: `job:${JOB}` })).toHaveLength(0);
  });

  it("most recent wins: an announcement after a recurring-task answer beats that answer", async () => {
    seedRepoStats();
    h.state.recordAnswer(MAIN, {
      sessionId: "s1",
      taskSlug: "repo-stats",
      ownerText: "How many clones did your repo get yesterday?",
      answerText: "68 unique clones.",
      now: T0 - 30 * MIN,
    });
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(JSON.stringify({ kind: "gap", missing: "Include unique visitors" }));
    const res = await ownerTurn({ text: "what about the unique visitors?", now: T0 + 30 * MIN });
    expect(res.jobLink?.jobId).toBe(JOB);
    expect(res.turn.gapContext).toMatchObject({ typedBy: "job", scope: `job:${JOB}` });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0]![0]).toContain(`Scheduled job "${JOB_NAME}"`);
    expect(llm.mock.calls[0]![0]).toContain(JOB_MESSAGE);
    expect(llm.mock.calls[0]![0]).toContain(REPORT);
    expect(h.practices.list({ scope: `job:${JOB}` })).toMatchObject([
      { statement: "Include unique visitors", status: "candidate", source: "extraction" },
    ]);
    expect(h.practices.list({ scope: "task:repo-stats" })).toHaveLength(0);
  });
});

describe("an explicit instruction about the report", () => {
  it("is saved at the job's scope at the owner tier, with one model call that carries the job section", async () => {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(SAVE_UNIQUES);
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + 20 * MIN });
    expect(llm).toHaveBeenCalledTimes(1);
    const prompt = llm.mock.calls[0]![0];
    expect(prompt).toContain("## Scheduled job report");
    expect(prompt).toContain(`the scheduled job "${JOB_NAME}" sent its report`);
    expect(prompt).toContain('"about_job": true');
    // The report is in the prompt once (the follow-up section carries it).
    expect(prompt.split(REPORT)).toHaveLength(2);
    expect(res.capture.practices).toMatchObject([
      {
        statement: UNIQUES,
        scope: `job:${JOB}`,
        status: "active",
        tier: "owner",
        op: "add",
        taskLabel: "the Repo traffic report",
      },
    ]);
    expect(res.capture.line).toBe(`Practice saved for the Repo traffic report: "${UNIQUES}"`);
    // Saved on the spot: no candidate and no offer.
    expect(res.finished.offerLine).toBeNull();
    expect(h.practices.list({ statuses: ["candidate"] })).toHaveLength(0);
  });

  it("is rendered in the next run of that job only: not in another job, not in the main chat", async () => {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(SAVE_UNIQUES);
    await ownerTurn({ text: ASK_UNIQUES, now: T0 + 20 * MIN });
    const next = runJob({ startedAt: T0 + DAY });
    expect(next.block).toContain(`- [this job] ${UNIQUES}`);
    const other = runJob({ jobId: "cron_other", startedAt: T0 + DAY + HOUR });
    expect(other.block).toBeUndefined();
    at(T0 + DAY + 2 * HOUR);
    const chat = buildPracticesBlock(blockManager(), {
      config: {},
      sessionKey: MAIN,
      senderIsOwner: true,
      promptMode: "full",
      prompt: "How many clones did your repo get yesterday?",
      runId: "chat-1",
    });
    expect(chat ?? "").not.toContain(UNIQUES);
  });

  it("stays out of the job when the model does not mark it as about the report", async () => {
    seedRepoStats();
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(
      practicesJson([
        { statement: "Stop asking where I live", explicit: true, about_job: false },
        { statement: "Stop asking about my timezone", explicit: true },
      ]),
    );
    const res = await ownerTurn({
      text: "stop asking where I live, and stop asking about my timezone",
      now: T0 + 20 * MIN,
    });
    expect(res.jobLink?.jobId).toBe(JOB);
    expect(res.capture.practices.map((p) => p.scope)).toEqual(["global", "global"]);
    expect(h.practices.list({ scope: `job:${JOB}` })).toHaveLength(0);
  });

  it("'everywhere' still wins over the job scope, and a non-owner turn stores nothing", async () => {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }]));
    const res = await ownerTurn({
      text: "give me the unique counts too, everywhere",
      now: T0 + 20 * MIN,
    });
    expect(res.capture.practices[0]).toMatchObject({ scope: "global" });

    runJob({ startedAt: T0 + DAY });
    const guest = await runCorrectionCapture({
      cfg: {},
      sessionKey: MAIN,
      userMessage: ASK_UNIQUES,
      assistantReply: "ok",
      senderIsOwner: false,
      isHeartbeat: false,
      runStartedAt: T0 + DAY + HOUR,
      store: null,
      job: takeLink(T0 + DAY + HOUR),
      practices: {
        save: async (input) => savePractice(h.db, h.practices, input),
        cronJobId: JOB,
      },
      pinAsOwner: null,
      llmCall: llm,
    });
    expect(guest.skipped).toBe("not-owner");
    expect(h.practices.list({ scope: `job:${JOB}` })).toHaveLength(0);
  });

  it("the job section asks for the correction flag only when the run carried a changed practice", () => {
    const link: JobLink = {
      jobId: JOB,
      scope: `job:${JOB}`,
      jobName: JOB_NAME,
      label: jobReportLabel(JOB_NAME),
      requestText: JOB_MESSAGE,
      outputText: REPORT,
      announcedAt: T0,
      canaries: [],
    };
    const plain = buildJobPromptSection(link, true);
    // The statement of a job practice must not name the job (found on a real
    // run: the extra words kept an explicit instruction below the owner tier).
    expect(plain).toContain("Do not name the job, the report or its subject");
    expect(plain).toContain(JOB_MESSAGE);
    expect(plain).toContain(REPORT);
    expect(plain).not.toContain('"correction"');
    const saved = h.practices.upsert({ statement: UNIQUES, scope: `job:${JOB}`, source: "owner" });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const withCanary = buildJobPromptSection({ ...link, canaries: [saved.practice] }, false);
    expect(withCanary).toContain(`"${UNIQUES}"`);
    expect(withCanary).toContain('"correction": true');
    expect(withCanary).not.toContain(REPORT);
    expect(withCanary).not.toContain("—");
  });
});

describe("a follow-up gap after the report", () => {
  const ASK = "what about the unique visitors?";
  const GAP = JSON.stringify({ kind: "gap", missing: "Include unique visitors" });
  const OFFER =
    "You have asked for unique visitors after the Repo traffic report twice. Include it every time? (yes / no)";

  it("is a candidate at the job's scope, offered the second time, and yes makes it the job's practice", async () => {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(GAP);
    const first = await ownerTurn({ text: ASK, now: T0 + HOUR });
    expect(first.finished.sighting).toMatchObject({ kind: "candidate", op: "add" });
    expect(first.finished.offerLine).toBeNull();
    const candidate = h.practices.list({ scope: `job:${JOB}` })[0]!;
    expect(candidate).toMatchObject({ status: "candidate", origin: "follow_up" });
    // A candidate is never given to the job.
    expect(runJob({ startedAt: T0 + DAY }).block).toBeUndefined();

    const second = await ownerTurn({ text: ASK, now: T0 + DAY + HOUR });
    expect(second.finished.sighting).toMatchObject({ kind: "candidate", op: "strengthen" });
    expect(second.finished.offerLine).toBe(OFFER);
    expect(h.state.get(MAIN)?.offerPracticeId).toBe(candidate.id);

    const yes = await ownerTurn({ text: "yes", now: T0 + DAY + HOUR + 5 * MIN });
    expect(yes.note).toContain("for the Repo traffic report");
    expect(yes.turn.answerLine).toBe(
      'Practice saved for the Repo traffic report: "Include unique visitors"',
    );
    expect(h.practices.get(candidate.id)).toMatchObject({ status: "active", source: "owner" });
    expect(runJob({ startedAt: T0 + 2 * DAY }).block).toContain("Include unique visitors");
  });

  it("one explicit instruction is enough for the offer", async () => {
    runJob({ startedAt: T0 });
    // The pass extracted no practice; the follow-up check found the gap.
    llm.mockResolvedValue(practicesJson([], { kind: "gap", missing: "Include the unique counts" }));
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + HOUR });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(res.finished.offerLine).toBe(
      "You asked for the unique counts after the Repo traffic report. Include it every time? (yes / no)",
    );
    expect(h.practices.list({ scope: `job:${JOB}` })).toMatchObject([{ status: "candidate" }]);
  });

  it("a new topic stores nothing, and no costs a declined candidate that is not stored again", async () => {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(JSON.stringify({ kind: "other" }));
    const other = await ownerTurn({ text: "can you book the dentist for friday?", now: T0 + HOUR });
    expect(other.jobLink?.jobId).toBe(JOB);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(h.practices.list()).toHaveLength(0);

    llm.mockResolvedValue(practicesJson([], { kind: "gap", missing: "Include the unique counts" }));
    runJob({ startedAt: T0 + DAY });
    await ownerTurn({ text: ASK_UNIQUES, now: T0 + DAY + HOUR });
    await ownerTurn({ text: "no", now: T0 + DAY + HOUR + MIN });
    expect(h.practices.list({ scope: `job:${JOB}` })).toMatchObject([{ status: "suppressed" }]);
    runJob({ startedAt: T0 + 2 * DAY });
    const again = await ownerTurn({ text: ASK_UNIQUES, now: T0 + 2 * DAY + HOUR });
    expect(again.finished.sighting).toEqual({ kind: "refused" });
    expect(again.finished.offerLine).toBeNull();
  });

  it("follow-ups switched off: the link still scopes an explicit instruction, and no gap check is made", async () => {
    const cfg: BitterbotConfig = { memory: { practices: { followUps: { enabled: false } } } };
    runJob({ startedAt: T0 });
    const plain = await ownerTurn({ text: ASK, now: T0 + HOUR, cfg });
    expect(plain.turn.gapContext).toBeNull();
    expect(llm).not.toHaveBeenCalled();
    runJob({ startedAt: T0 + DAY });
    llm.mockResolvedValue(practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }]));
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + DAY + HOUR, cfg });
    expect(res.capture.practices[0]).toMatchObject({ scope: `job:${JOB}`, status: "active" });
  });
});

describe("the canary line", () => {
  async function teachUniques(now = T0 + 20 * MIN) {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(SAVE_UNIQUES);
    const res = await ownerTurn({ text: ASK_UNIQUES, now });
    llm.mockResolvedValue(JSON.stringify({ kind: "other" }));
    return res.capture.practices[0]!.id;
  }

  it("is on the first run after the practice was saved, once, whether or not the owner replies", async () => {
    const id = await teachUniques();
    const first = runJob({ startedAt: T0 + DAY, reply: REPORT_WITH_UNIQUES });
    expect(first.canary.line).toBe(
      `Changed since last time: "${UNIQUES}" (from your message on 20 Nov).`,
    );
    expect(first.announcement?.canaryPracticeIds).toEqual([id]);
    expect(h.practices.events(id).filter((e) => e.kind === "canary")).toHaveLength(1);
    // Nobody replied. The next run has no line.
    const second = runJob({ startedAt: T0 + 2 * DAY, reply: REPORT_WITH_UNIQUES });
    expect(second.canary).toEqual({ line: null, practiceIds: [] });
    expect(second.announcement?.canaryPracticeIds).toEqual([]);
  });

  it("is shown again after the owner rewords the practice, and counts several changes in one line", async () => {
    const id = await teachUniques();
    runJob({ startedAt: T0 + DAY, reply: REPORT_WITH_UNIQUES });
    at(T0 + DAY + HOUR);
    expect(h.practices.editStatement(id, "Include the unique counts per day").ok).toBe(true);
    at(T0 + DAY + 2 * HOUR);
    const added = savePractice(h.db, h.practices, {
      statement: "Include the top referrers",
      scope: `job:${JOB}`,
      origin: "owner_ui",
    });
    expect(added.ok).toBe(true);
    const run = runJob({ startedAt: T0 + 2 * DAY, reply: REPORT_WITH_UNIQUES });
    expect(run.canary.line).toBe(
      'Changed since last time: "Include the top referrers" (saved on 21 Nov), and 1 more.',
    );
    expect(run.canary.practiceIds).toHaveLength(2);
    expect(runJob({ startedAt: T0 + 3 * DAY }).canary.line).toBeNull();
  });

  it("waits for a run that was given the practice, and a change made during a run waits for the next", async () => {
    runJob({ startedAt: T0 });
    at(T0 + 30 * MIN);
    const saved = savePractice(h.db, h.practices, { statement: UNIQUES, scope: `job:${JOB}` });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    // A run whose prompt did not carry it (it started before the save).
    at(T0 + HOUR);
    expect(
      prepareJobRun(h.practices, {
        jobId: JOB,
        reply: REPORT,
        runStartedAt: T0 + 10 * MIN,
        timeZone: TZ,
      }),
    ).toEqual({ line: null, practiceIds: [] });
    expect(runJob({ startedAt: T0 + DAY }).canary.line).toContain(UNIQUES);
  });

  it("a report that does not show the job's practice is counted as not followed", async () => {
    const id = await teachUniques();
    const run = runJob({ startedAt: T0 + DAY, reply: REPORT });
    // The line still says what changed in the job's instructions.
    expect(run.canary.line).toContain(UNIQUES);
    expect(h.practices.counters().byPractice.get(id)).toMatchObject({ applied: 1, notFollowed: 1 });
    expect(h.practices.events(id).find((e) => e.kind === "not_followed")?.detail).toEqual({
      via: "job",
    });
    runJob({ startedAt: T0 + 2 * DAY, reply: REPORT_WITH_UNIQUES });
    expect(h.practices.counters().byPractice.get(id)).toMatchObject({ applied: 2, notFollowed: 1 });
  });

  it("formats without an em-dash and clips a long statement", () => {
    const line = formatCanaryLine({
      statement: `Include ${"very ".repeat(80)}long things.`,
      savedAt: T0,
      fromMessage: true,
      more: 0,
      timeZone: TZ,
      now: T0,
    });
    expect(line.length).toBeLessThanOrEqual(320);
    expect(line).not.toContain("—");
    expect(formatRollbackLine("Include  the unique counts.")).toBe(
      'Rolled back: "Include the unique counts". The job runs as before.',
    );
  });
});

describe("rollback", () => {
  async function taughtAndRun(reply = REPORT) {
    runJob({ startedAt: T0 });
    llm.mockResolvedValue(SAVE_UNIQUES);
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + 20 * MIN });
    const id = res.capture.practices[0]!.id;
    const run = runJob({ startedAt: T0 + DAY, reply });
    expect(run.canary.practiceIds).toEqual([id]);
    return id;
  }
  const retiredEvent = (id: string) => h.practices.events(id).find((e) => e.kind === "retired");

  it("the owner repeating the instruction right after the canary run is counted, never rolled back", async () => {
    const id = await taughtAndRun();
    llm.mockResolvedValue(
      practicesJson([{ statement: UNIQUES, explicit: true, about_job: true, correction: false }]),
    );
    const res = await ownerTurn({
      text: "You still did not include the unique counts. Give me the unique counts every time.",
      now: T0 + DAY + HOUR,
    });
    expect(res.jobLink?.canaries.map((c) => c.id)).toEqual([id]);
    expect(llm.mock.calls.at(-1)![0]).toContain(`follows this standing instruction: "${UNIQUES}"`);
    // Asking again for the same thing must not remove it.
    expect(res.capture.practices.some((p) => p.op === "rollback")).toBe(false);
    expect(h.practices.get(id)?.status).toBe("active");
    expect(retiredEvent(id)).toBeUndefined();
    expect(h.practices.counters().byPractice.get(id)?.repeats).toBe(1);
    expect(listAuditLog(h.db, { limit: 5 }).some((e) => e.event === "practice_rolled_back")).toBe(
      false,
    );
    // The job keeps the practice on its next run.
    expect(runJob({ startedAt: T0 + 2 * DAY }).block).toContain(UNIQUES);
  });

  it("a repeat in other words still counts: the stored practice names more than the owner says now", async () => {
    // What a real model stored on the live run, and the owner's shorter repeat.
    runJob({ startedAt: T0 });
    at(T0 + 20 * MIN);
    const saved = savePractice(h.db, h.practices, {
      statement: "Include unique counts every time you report repo traffic.",
      scope: `job:${JOB}`,
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    runJob({ startedAt: T0 + DAY });
    llm.mockResolvedValue(
      practicesJson([{ statement: UNIQUES, explicit: true, about_job: true, correction: false }]),
    );
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + DAY + HOUR });
    expect(res.capture.practices.some((p) => p.op === "rollback")).toBe(false);
    expect(retiredEvent(saved.practice.id)).toBeUndefined();
    expect(h.practices.get(saved.practice.id)?.status).toBe("active");
    expect(h.practices.counters().byPractice.get(saved.practice.id)?.repeats).toBe(1);
  });

  it("the live case: the model restates the instruction with the report's name in it, at exactly half the owner-tier rule", async () => {
    const LONG = "Include unique counts every time you report repo traffic.";
    runJob({ startedAt: T0 });
    at(T0 + 20 * MIN);
    const saved = savePractice(h.db, h.practices, { statement: LONG, scope: `job:${JOB}` });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const run = runJob({
      startedAt: T0 + DAY,
      reply: "Yesterday (2026-11-26):\n\nClones: 379 (45 unique)\nViews: 107 (74 unique)",
    });
    expect(run.canary.practiceIds).toEqual([saved.practice.id]);
    // One of the practice's seven content words is in that report: neither
    // shown as followed nor counted as not followed.
    expect(h.practices.counters().byPractice.get(saved.practice.id)?.notFollowed ?? 0).toBe(0);
    llm.mockResolvedValue(practicesJson([{ statement: LONG, explicit: true, about_job: true }]));
    const res = await ownerTurn({ text: ASK_UNIQUES, now: T0 + DAY + HOUR });
    expect(res.capture.practices.some((p) => p.op === "rollback")).toBe(false);
    expect(h.practices.get(saved.practice.id)?.status).toBe("active");
    expect(h.practices.counters().byPractice.get(saved.practice.id)?.repeats).toBe(1);
  });

  it("a repeated instruction the model flags as a correction is still not a contradiction", async () => {
    const id = await taughtAndRun();
    llm.mockResolvedValue(
      practicesJson([{ statement: UNIQUES, explicit: true, about_job: true, correction: true }]),
    );
    await ownerTurn({
      text: "No, I said give me the unique counts every time.",
      now: T0 + DAY + HOUR,
    });
    expect(h.practices.get(id)?.status).toBe("active");
    expect(retiredEvent(id)).toBeUndefined();
  });

  it("the owner rejecting the change rolls it back and stores no opposite practice", async () => {
    const id = await taughtAndRun(REPORT_WITH_UNIQUES);
    llm.mockResolvedValue(
      practicesJson([
        {
          statement: "Stop including the unique counts",
          explicit: true,
          about_job: true,
          correction: true,
        },
      ]),
    );
    const res = await ownerTurn({
      text: "no, stop including the unique counts",
      now: T0 + DAY + HOUR,
    });
    expect(res.capture.practices).toMatchObject([{ id, op: "rollback", status: "retired" }]);
    expect(retiredEvent(id)?.detail).toMatchObject({
      reason: "rolled_back",
      because: "contradicted",
    });
    // A rejection is not a repeat.
    expect(h.practices.counters().byPractice.get(id)?.repeats ?? 0).toBe(0);
    expect(h.practices.list()).toHaveLength(1);
  });

  it("a follow-up that asks again for what the job was changed to include is a repeat, not a rollback", async () => {
    const id = await taughtAndRun();
    llm.mockResolvedValue(JSON.stringify({ kind: "gap", missing: "Include unique counts" }));
    const res = await ownerTurn({ text: "and the unique counts?", now: T0 + DAY + HOUR });
    expect(res.finished.sighting).toMatchObject({ kind: "repeat" });
    expect(res.finished.rollbackLine ?? null).toBeNull();
    expect(retiredEvent(id)).toBeUndefined();
    expect(h.practices.get(id)?.status).toBe("active");
  });

  it("fails closed: no flag, an inferred statement, another subject or a later message roll nothing back", async () => {
    const id = await taughtAndRun(REPORT_WITH_UNIQUES);
    // A different instruction about the report, not marked as a correction.
    llm.mockResolvedValue(
      practicesJson([{ statement: "Put the views first", explicit: true, about_job: true }]),
    );
    const other = await ownerTurn({ text: "you should put the views first", now: T0 + DAY + HOUR });
    expect(other.capture.practices).toMatchObject([{ op: "add", scope: `job:${JOB}` }]);
    expect(h.practices.get(id)?.status).toBe("active");

    // The model marks a correction, but the owner did not say the statement.
    runJob({ startedAt: T0 + 2 * DAY, reply: REPORT_WITH_UNIQUES });
    at(T0 + 2 * DAY + 30 * MIN);
    expect(h.practices.editStatement(id, "Include the unique counts per day").ok).toBe(true);
    runJob({ startedAt: T0 + 3 * DAY, reply: REPORT_WITH_UNIQUES });
    llm.mockResolvedValue(
      practicesJson([
        {
          statement: "Stop including the unique counts",
          explicit: false,
          about_job: true,
          correction: true,
        },
      ]),
    );
    await ownerTurn({ text: "no, that is not what I meant", now: T0 + 3 * DAY + HOUR });
    expect(h.practices.get(id)?.status).toBe("active");

    // The canary run is two owner messages back: the link is gone.
    llm.mockResolvedValue(
      practicesJson([
        {
          statement: "Stop including the unique counts",
          explicit: true,
          about_job: true,
          correction: true,
        },
      ]),
    );
    const late = await ownerTurn({
      text: "no, stop including the unique counts",
      now: T0 + 3 * DAY + 2 * HOUR,
    });
    expect(late.jobLink).toBeNull();
    expect(h.practices.get(id)?.status).toBe("active");
  });

  it("only an active job practice can be rolled back", () => {
    const task = h.practices.upsert({ statement: UNIQUES, scope: "global", source: "owner" });
    if (!task.ok) {
      throw new Error(task.reason);
    }
    expect(
      rollbackPractice(h.db, h.practices, task.practice.id, {
        via: "correction",
        because: "repeated",
      }),
    ).toBe(false);
    expect(h.practices.get(task.practice.id)?.status).toBe("active");
  });
});

describe("the experience file", () => {
  const agentDir = () => path.join(dir, "agent");
  const file = () => resolveJobExperiencePath(agentDir(), JOB)!;
  const sync = (jobExists?: (id: string) => boolean | undefined) =>
    syncJobExperienceFiles({
      store: h.practices,
      agentDir: agentDir(),
      jobName: (id) => (id === JOB ? JOB_NAME : undefined),
      jobExists,
      timeZone: TZ,
    });

  it("lists the active practices with their dates and a dated list of changes, and is rewritten from the store", async () => {
    vi.useRealTimers();
    const saved = h.practices.upsert({
      statement: UNIQUES,
      scope: `job:${JOB}`,
      source: "owner",
      evidenceRef: "session:/x/main.jsonl#L12",
      now: T0,
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const id = saved.practice.id;
    expect(await sync()).toEqual([file()]);
    expect(file()).toBe(path.join(agentDir(), "cron", JOB, "EXPERIENCE.md"));
    const first = fs.readFileSync(file(), "utf-8");
    expect(first).toContain(`# What this job has learned: ${JOB_NAME}`);
    expect(first).toContain(`Job id: \`${JOB}\``);
    expect(first).toContain(`- ${UNIQUES} (in effect since 2026-11-20; you said it on 2026-11-20)`);
    expect(first).toContain(`- 2026-11-20: saved "${UNIQUES}" (from your message)`);
    expect(first).toContain("The job does not read this file");
    expect(first).not.toContain("—");
    // Nothing changed: nothing is rewritten.
    expect(await sync()).toEqual([]);

    h.practices.editStatement(id, "Include the unique counts per day", T0 + DAY);
    rollbackPractice(h.db, h.practices, id, { via: "correction", because: "contradicted" });
    const retiredAt = h.practices.events(id).find((e) => e.kind === "retired")!.ts;
    expect(await sync()).toEqual([file()]);
    const second = fs.readFileSync(file(), "utf-8");
    expect(second).toContain("None. The job runs on its own instruction only.");
    expect(second).toContain(
      `- 2026-11-21: reworded to "Include the unique counts per day" (was "${UNIQUES}")`,
    );
    // The first line keeps the wording the practice had when it was saved.
    expect(second).toContain(`- 2026-11-20: saved "${UNIQUES}" (from your message)`);
    expect(second).toContain(
      `- ${new Date(retiredAt).toISOString().slice(0, 10)}: rolled back "Include the unique counts per day" (you rejected it in your next message after the first run that used it)`,
    );
    // A hand edit does not survive the next change.
    fs.writeFileSync(file(), "edited by hand");
    expect(await sync()).toEqual([file()]);
    expect(fs.readFileSync(file(), "utf-8")).toBe(second);
  });

  it("is removed when the job is deleted, and when its last practice moves away", async () => {
    vi.useRealTimers();
    const saved = h.practices.upsert({ statement: UNIQUES, scope: `job:${JOB}`, source: "owner" });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    await sync();
    expect(fs.existsSync(file())).toBe(true);
    // The cron engine no longer has the job: the file goes, the practice row stays.
    expect(await sync((id) => id !== JOB)).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(path.dirname(file()))).toBe(false);
    expect(fs.existsSync(path.join(agentDir(), "cron"))).toBe(false);
    expect(h.practices.get(saved.practice.id)?.status).toBe("active");

    await sync();
    expect(fs.existsSync(file())).toBe(true);
    expect(await removeJobExperience(agentDir(), JOB)).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
    expect(await removeJobExperience(agentDir(), JOB)).toBe(false);

    await sync();
    h.practices.setScope(saved.practice.id, "global");
    await sync();
    expect(fs.existsSync(file())).toBe(false);
  });

  it("a job with candidates only has no file", async () => {
    vi.useRealTimers();
    const candidate = h.practices.upsert({
      statement: "Include unique visitors.",
      scope: `job:${JOB}`,
      source: "extraction",
    });
    if (!candidate.ok) {
      throw new Error(candidate.reason);
    }
    expect(await sync()).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
    h.practices.activate(candidate.practice.id);
    expect(await sync()).toEqual([file()]);
    // The statement's own full stop is not doubled up.
    expect(fs.readFileSync(file(), "utf-8")).toContain(
      "- Include unique visitors (in effect since",
    );
  });

  it("a job id can never point outside the agent's cron folder", async () => {
    expect(resolveJobExperiencePath(agentDir(), "../../etc")).toBeNull();
    expect(resolveJobExperiencePath(agentDir(), "Daily/Stats")).toBe(
      path.join(agentDir(), "cron", "dailystats", "EXPERIENCE.md"),
    );
    expect(resolveJobExperiencePath(agentDir(), "..")).toBeNull();
    expect(resolveJobExperiencePath(agentDir(), "/")).toBeNull();
    expect(await removeJobExperience(agentDir(), "..")).toBe(false);
    expect(
      renderJobExperience({
        jobId: JOB,
        practices: [],
        eventsOf: () => [],
        savedAt: () => null,
        timeZone: TZ,
      }),
    ).toContain("None yet.");
  });
});
