/**
 * PLAN-64 Phase 5: a scheduled job that learns, end to end over the real
 * pieces: the cron side (beginJobAnnouncement), the memory manager's glue
 * (called on the real prototype with a minimal `this`), the job's prompt
 * (buildPracticesBlock) and the owner's reply path
 * (runCorrectionCaptureAfterTurn), with canned model output.
 *
 * Under test: the announcement is recorded and the owner's next message is
 * linked to the job; the instruction is saved for that job and reaches its
 * next run; that run carries the canary line once; a rejection rolls the
 * practice back and says so; EXPERIENCE.md follows every step and goes when
 * the job is deleted; `memory.practices.jobs.enabled: false` turns all of it
 * off.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPracticesBlock, type PracticesBlockManager } from "../../agents/practices-block.js";
import type { BitterbotConfig } from "../../config/config.js";
import { setActiveCronEngine } from "../../cron/active.js";
import type { CronEngine } from "../../cron/engine.js";
import {
  beginJobAnnouncement,
  forgetJobPractices,
  jobScopeLabel,
  readActiveJobPractices,
  readJobsByScopeName,
} from "../../cron/job-practices.js";
import type { CronJob } from "../../cron/types.js";
import { MaintenanceMutex } from "../../memory/maintenance-mutex.js";
import { MemoryIndexManager } from "../../memory/manager.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  getManager: vi.fn(),
  peekManager: vi.fn(),
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: (params: unknown) => state.getManager(params),
  peekMemorySearchManager: (params: unknown) => state.peekManager(params),
}));

import { runCorrectionCaptureAfterTurn } from "./agent-runner-memory.js";

const MAIN = "agent:main:main";
const JOB_ID = "cron_traffic1";
const REPORT = "Yesterday the repo had 240 clones and 1,310 views.";
const REPORT_2 =
  "Yesterday the repo had 240 clones (68 unique) and 1,310 views. Unique counts included.";
const UNIQUES = "Include the unique counts";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);

const JOB: CronJob = {
  jobId: JOB_ID,
  name: "Repo traffic",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *" },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Report yesterday's clone and view counts." },
  consecutiveErrors: 0,
  createdAt: T0,
  updatedAt: T0,
};

type Glue = Pick<
  MemoryIndexManager,
  | "practices"
  | "taskTypes"
  | "followUpState"
  | "jobAnnouncements"
  | "practiceFollowUpDeps"
  | "resolveCaptureTaskType"
  | "ownerSavePractice"
  | "ownerSetPracticeScope"
  | "ownerRollbackPractice"
  | "takePracticeJobLink"
  | "practiceJobRunCanary"
  | "recordPracticeJobAnnouncement"
  | "queueJobExperienceSync"
  | "forgetPracticeJob"
>;

const llm = vi.fn();
let dir: string;
let db: DatabaseSync;
let g: Glue;
let cfg: BitterbotConfig;
let jobs: CronJob[];

function makeCfg(practices?: Record<string, unknown>): BitterbotConfig {
  return {
    agents: {
      defaults: { userTimezone: "UTC" },
      list: [{ id: "main", default: true, agentDir: path.join(dir, "agent") }],
    },
    ...(practices ? { memory: { practices } } : {}),
  } as BitterbotConfig;
}

function open(config: BitterbotConfig): void {
  cfg = config;
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  const raw = Object.assign(
    Object.create(MemoryIndexManager.prototype) as Record<string, unknown>,
    {
      cfg,
      db,
      agentId: "main",
      syncing: null,
      maintenanceMutex: new MaintenanceMutex(),
      practicesStore: null,
      taskTypesStore: null,
      followUpStateStore: null,
      jobAnnouncementStore: null,
      jobExperienceSync: Promise.resolve(),
      correctionLlmCall: () => llm,
    },
  );
  g = raw as unknown as Glue;
  // What the reply path sees: the real glue for everything practices.
  const manager = {
    canonicalFacts: () => null,
    correctionLlmCall: () => llm,
    practices: () => g.practices(),
    taskTypes: () => g.taskTypes(),
    ownerSavePractice: (input: Parameters<Glue["ownerSavePractice"]>[0]) =>
      g.ownerSavePractice(input),
    ownerSetPracticeScope: (id: string, scope: string) => g.ownerSetPracticeScope(id, scope),
    resolveCaptureTaskType: (key: string | undefined, text: string) =>
      g.resolveCaptureTaskType(key, text),
    practiceFollowUpDeps: () => g.practiceFollowUpDeps(),
    takePracticeJobLink: (key: string | undefined) => g.takePracticeJobLink(key),
    ownerRollbackPractice: (id: string, detail: Parameters<Glue["ownerRollbackPractice"]>[1]) =>
      g.ownerRollbackPractice(id, detail),
    forgetPracticeJob: (jobId: string) => g.forgetPracticeJob(jobId),
  };
  state.peekManager.mockResolvedValue({ manager, error: null });
  state.getManager.mockResolvedValue({ manager, error: null });
}

/** One run of the job: its prompt is built, then its report is announced. */
async function runJob(startedAt: number, reply: string) {
  vi.setSystemTime(startedAt);
  const block = buildPracticesBlock(g as unknown as PracticesBlockManager, {
    config: cfg,
    sessionKey: `cron:${JOB_ID}`,
    promptMode: "full",
    prompt: `[cron:${JOB_ID} Repo traffic] ${JOB.payload.kind === "agentTurn" ? JOB.payload.message : ""}`,
    runId: `job-run-${startedAt}`,
  });
  vi.setSystemTime(startedAt + 60_000);
  const hook = await beginJobAnnouncement({
    cfg,
    job: JOB,
    agentId: "main",
    reply,
    runStartedAt: startedAt,
    manager: g,
  });
  hook.announced("main");
  return { block, canaryLine: hook.canaryLine };
}

async function ownerTurn(body: string, now: number) {
  vi.setSystemTime(now);
  const line = await runCorrectionCaptureAfterTurn({
    cfg,
    followupRun: {
      prompt: "x",
      enqueuedAt: now,
      run: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: MAIN,
        senderIsOwner: true,
        sessionFile: "/nonexistent/session.jsonl",
        workspaceDir: dir,
        config: cfg,
      },
    } as unknown as FollowupRun,
    sessionKey: MAIN,
    commandBody: body,
    replyText: "Done.",
    isHeartbeat: false,
    chatType: "direct",
    runStartedAt: now,
  });
  await line?.markDelivered();
  return line?.text ?? null;
}

const experienceFile = () => path.join(dir, "agent", "cron", JOB_ID, "EXPERIENCE.md");
const practicesJson = (practices: Array<Record<string, unknown>>) =>
  JSON.stringify({ facts: [], practices, follow_up: { kind: "other" } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  llm.mockReset();
  state.getManager.mockReset();
  state.peekManager.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-job-practices-"));
  jobs = [JOB];
  setActiveCronEngine({ listJobs: () => jobs } as unknown as CronEngine);
  open(makeCfg());
});

afterEach(() => {
  vi.useRealTimers();
  setActiveCronEngine(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a scheduled job that learns from the owner's correction (PLAN-64 Phase 5)", () => {
  it("announce, correct, run with the canary, reject, roll back, delete", async () => {
    // Run 1: no practices, no line; the announcement is recorded.
    const first = await runJob(T0, REPORT);
    expect(first.block).toBeUndefined();
    expect(first.canaryLine).toBeNull();
    expect(g.jobAnnouncements().latest(MAIN)).toMatchObject({
      jobId: JOB_ID,
      jobName: "Repo traffic",
      destination: "main",
      outputText: REPORT,
      consumedAt: null,
    });

    // The owner's next message in the main conversation.
    llm.mockResolvedValue(practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }]));
    expect(await ownerTurn("give me the unique counts too every time", T0 + HOUR)).toBe(
      `Practice saved for the Repo traffic report: "${UNIQUES}"`,
    );
    expect(llm).toHaveBeenCalledTimes(1);
    const [practice] = g.practices().list({ scope: `job:${JOB_ID}` });
    expect(practice).toMatchObject({ statement: UNIQUES, status: "active", source: "owner" });
    expect(g.jobAnnouncements().latest(MAIN)?.consumedAt).toBe(T0 + HOUR);
    await g.queueJobExperienceSync();
    expect(fs.readFileSync(experienceFile(), "utf-8")).toContain(
      `- ${UNIQUES} (in effect since 2026-11-20`,
    );
    // The owner surfaces show it with the job's name.
    const byScope = await readJobsByScopeName(cfg);
    expect(jobScopeLabel(practice!.scope, byScope)).toBe("Repo traffic");
    expect(jobScopeLabel("job:gone_job", byScope)).toBe("gone_job");
    expect(jobScopeLabel("task:repo-stats", byScope)).toBeUndefined();

    // Run 2: the practice is in the job's prompt, the report says what changed.
    const second = await runJob(T0 + DAY, REPORT_2);
    expect(second.block).toContain(`- [this job] ${UNIQUES}`);
    expect(second.canaryLine).toBe(
      `Changed since last time: "${UNIQUES}" (from your message on 20 Nov).`,
    );
    expect(g.jobAnnouncements().latest(MAIN)?.canaryPracticeIds).toEqual([practice!.id]);

    // The owner rejects the change in their next message.
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
    expect(await ownerTurn("no, stop including the unique counts", T0 + DAY + HOUR)).toBe(
      `Rolled back: "${UNIQUES}". The job runs as before.`,
    );
    expect(g.practices().get(practice!.id)?.status).toBe("retired");
    expect(g.practices().list({ statuses: ["active", "candidate"] })).toHaveLength(0);
    await g.queueJobExperienceSync();
    const file = fs.readFileSync(experienceFile(), "utf-8");
    expect(file).toContain("None. The job runs on its own instruction only.");
    expect(file).toContain(`rolled back "${UNIQUES}" (you rejected it`);

    // Run 3 is as before: nothing in the prompt, no line.
    const third = await runJob(T0 + 2 * DAY, REPORT);
    expect(third.block).toBeUndefined();
    expect(third.canaryLine).toBeNull();

    // The job is deleted: the file and the announcement records go.
    jobs = [];
    await forgetJobPractices(cfg, JOB);
    expect(fs.existsSync(experienceFile())).toBe(false);
    expect(g.jobAnnouncements().listForJob(JOB_ID)).toHaveLength(0);
    // The practice row is kept and can still be listed.
    expect(g.practices().get(practice!.id)).not.toBeNull();
  });

  it("cron.list gets each job's active practices", async () => {
    await runJob(T0, REPORT);
    llm.mockResolvedValue(practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }]));
    await ownerTurn("give me the unique counts too every time", T0 + HOUR);
    const practicesOf = async () => {
      // readActiveJobPractices opens the manager itself; here it gets the glue.
      const spy = vi
        .spyOn(MemoryIndexManager, "get")
        .mockResolvedValue(g as unknown as MemoryIndexManager);
      try {
        return await readActiveJobPractices(cfg, [JOB, { ...JOB, jobId: "cron_other" }]);
      } finally {
        spy.mockRestore();
      }
    };
    const taught = await practicesOf();
    expect([...taught.keys()]).toEqual([JOB_ID]);
    expect(taught.get(JOB_ID)).toEqual([
      { id: expect.any(String), statement: UNIQUES, savedAt: T0 + HOUR },
    ]);
  });

  it("memory.practices.jobs.enabled=false: no announcement record, no link, no canary line", async () => {
    db.close();
    open(makeCfg({ jobs: { enabled: false } }));
    const first = await runJob(T0, REPORT);
    expect(first.canaryLine).toBeNull();
    expect(g.jobAnnouncements().latest(MAIN)).toBeNull();
    // Even with a record from before the switch was turned off, nothing links.
    g.jobAnnouncements().record({
      jobId: JOB_ID,
      jobName: "Repo traffic",
      sessionKey: MAIN,
      requestText: "x",
      outputText: REPORT,
      now: T0 + 60_000,
    });
    llm.mockResolvedValue(practicesJson([{ statement: UNIQUES, explicit: true, about_job: true }]));
    expect(await ownerTurn("give me the unique counts too every time", T0 + HOUR)).toBe(
      `Practice saved for everything: "${UNIQUES}"`,
    );
    expect(llm.mock.calls[0]![0]).not.toContain("## Scheduled job report");
    expect(g.practices().list()).toMatchObject([{ scope: "global" }]);
    expect(g.jobAnnouncements().latest(MAIN)?.consumedAt).toBeNull();
    // A practice saved for the job by hand is still given to it, without a line.
    const saved = await g.ownerSavePractice({
      statement: "Include top referrers",
      scope: `job:${JOB_ID}`,
    });
    expect(saved.ok).toBe(true);
    const next = await runJob(T0 + DAY, REPORT);
    expect(next.block).toContain("Include top referrers");
    expect(next.canaryLine).toBeNull();
  });

  it('session.memory "off": the report is not kept and nothing links, but a canary is still used up', async () => {
    db.close();
    open({ ...makeCfg(), session: { memory: "off" } } as BitterbotConfig);
    const saved = await g.ownerSavePractice({ statement: UNIQUES, scope: `job:${JOB_ID}` });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const first = await runJob(T0 + HOUR, REPORT_2);
    expect(first.canaryLine).toContain(UNIQUES);
    expect(g.jobAnnouncements().latest(MAIN)).toBeNull();
    expect(
      g
        .practices()
        .events(saved.practice.id)
        .filter((e) => e.kind === "canary"),
    ).toHaveLength(1);
    expect((await runJob(T0 + DAY, REPORT_2)).canaryLine).toBeNull();
  });

  it("a task wakeup, a job a guest scheduled and a main-session job never take part", async () => {
    const record = vi.fn();
    const canary = vi.fn(() => ({ line: "x", practiceIds: [] }));
    const manager = { practiceJobRunCanary: canary, recordPracticeJobAnnouncement: record };
    const variants: CronJob[] = [
      { ...JOB, payload: { kind: "agentTurn", message: "resume", taskId: "task-1" } },
      { ...JOB, payload: { kind: "agentTurn", message: "report", senderIsOwner: false } },
      { ...JOB, sessionTarget: "main", payload: { kind: "systemEvent", text: "ping" } },
    ];
    for (const job of variants) {
      const hook = await beginJobAnnouncement({
        cfg,
        job,
        agentId: "main",
        reply: REPORT,
        runStartedAt: T0,
        manager,
      });
      hook.announced("main");
      expect(hook.canaryLine).toBeNull();
    }
    expect(canary).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    // A manager that throws never breaks the run.
    const broken = await beginJobAnnouncement({
      cfg,
      job: JOB,
      agentId: "main",
      reply: REPORT,
      runStartedAt: T0,
      manager: {
        practiceJobRunCanary: () => {
          throw new Error("db closed");
        },
        recordPracticeJobAnnouncement: record,
      },
    });
    expect(broken.canaryLine).toBeNull();
  });
});
