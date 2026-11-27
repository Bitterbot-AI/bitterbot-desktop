/**
 * The delivery decision of an isolated cron run happens before the agent
 * turn. A job created in the Control UI (no delivery block) used to run the
 * turn, pay for it, and then throw "announce delivery requires both
 * delivery.channel and delivery.to" on every run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { CronJob } from "./types.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  deliver: vi.fn(async (_params: Record<string, unknown>) => []),
  enqueueSystemEvent: vi.fn(),
  requestHeartbeatNow: vi.fn(),
  store: {} as Record<string, unknown>,
  // PLAN-64 Phase 5: the practices side of an announcement (job-practices.ts).
  canaryLine: null as string | null,
  announced: vi.fn(),
  beginJobAnnouncement: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../infra/outbound/deliver.js", () => ({ deliverOutboundPayloads: mocks.deliver }));
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent: mocks.enqueueSystemEvent }));
vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeatNow: mocks.requestHeartbeatNow }));
vi.mock("./job-practices.js", () => ({
  beginJobAnnouncement: async (params: unknown) => {
    mocks.beginJobAnnouncement(params);
    return { canaryLine: mocks.canaryLine, announced: mocks.announced };
  },
  forgetJobPractices: async () => {},
}));
vi.mock("../agents/tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(async () => "Three new issues were opened overnight."),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});
vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: () => "/nonexistent/sessions.json",
    loadSessionStore: () => mocks.store,
    resolveAgentMainSessionKey: () => "agent:main:main",
  };
});

const { runIsolatedJob } = await import("./isolated-agent.js");

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    jobId: "ui-job",
    name: "morning digest",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize new issues." },
    consecutiveErrors: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.callGateway.mockReset();
  mocks.callGateway.mockImplementation(async (request: { method: string }) =>
    request.method === "agent" ? { runId: "run-1" } : { status: "ok" },
  );
  mocks.deliver.mockClear();
  mocks.enqueueSystemEvent.mockClear();
  mocks.requestHeartbeatNow.mockClear();
  mocks.store = {};
  mocks.canaryLine = null;
  mocks.announced.mockClear();
  mocks.beginJobAnnouncement.mockClear();
});

describe("isolated cron run delivery", () => {
  it("fails before the turn when announce was asked for and there is no target", async () => {
    await expect(runIsolatedJob(job({ delivery: { mode: "announce" } }))).rejects.toThrow(
      /announce delivery has no usable target/,
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("keeps a default job's result in the main session when there is no route", async () => {
    await runIsolatedJob(job());
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mocks.enqueueSystemEvent.mock.calls[0]!;
    expect(text).toContain("[cron:ui-job morning digest]");
    expect(text).toContain("not sent to a channel");
    expect(text).toContain("Three new issues were opened overnight.");
    expect(options).toMatchObject({ sessionKey: "agent:main:main" });
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledTimes(1);
  });

  it("delivers a default job to the main session's last route", async () => {
    mocks.store = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 0,
        lastChannel: "telegram",
        lastTo: "12345",
      } as unknown as SessionEntry,
    };
    await runIsolatedJob(job());
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![0]).toMatchObject({
      channel: "telegram",
      to: "12345",
      payloads: [{ text: "Three new issues were opened overnight." }],
    });
    expect(mocks.enqueueSystemEvent.mock.calls[0]![0]).toContain("delivered to telegram:12345");
  });

  it("posts nothing for delivery.mode none", async () => {
    await runIsolatedJob(job({ delivery: { mode: "none" } }));
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });
  it("tells the agent when a one-shot runs late, and marks a non-owner wakeup", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await runIsolatedJob(
      job({
        schedule: { kind: "at", at: threeHoursAgo },
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "Resume task t1.", senderIsOwner: false },
      }),
    );
    const agentCall = mocks.callGateway.mock.calls
      .map((call) => call[0] as { method: string; params: Record<string, unknown> })
      .find((call) => call.method === "agent");
    expect(agentCall?.params.message).toContain("Resume task t1.");
    expect(agentCall?.params.message).toContain("running 3 hours late");
    expect(agentCall?.params.senderIsOwner).toBe(false);
  });

  // ── PLAN-64 Phase 5: the canary line and the announcement record ──────────

  const CANARY = 'Changed since last time: "Include unique counts" (from your message on 27 Nov).';

  it("adds the generated line to a delivered report and records the announcement after the send", async () => {
    mocks.store = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 0,
        lastChannel: "telegram",
        lastTo: "12345",
      } as unknown as SessionEntry,
    };
    mocks.canaryLine = CANARY;
    await runIsolatedJob(job());
    expect(mocks.beginJobAnnouncement).toHaveBeenCalledTimes(1);
    expect(mocks.beginJobAnnouncement.mock.calls[0]![0]).toMatchObject({
      agentId: "main",
      reply: "Three new issues were opened overnight.",
      runStartedAt: expect.any(Number),
    });
    expect(mocks.deliver.mock.calls[0]![0]).toMatchObject({
      payloads: [{ text: `Three new issues were opened overnight.\n\n${CANARY}` }],
    });
    expect(mocks.announced).toHaveBeenCalledTimes(1);
    expect(mocks.announced).toHaveBeenCalledWith("telegram:12345");
    // The main-session summary of a delivered report is unchanged.
    expect(mocks.enqueueSystemEvent.mock.calls[0]![0]).not.toContain("Changed since last time");
  });

  it("puts the line, whole, after the truncated summary of a report kept in the main session", async () => {
    mocks.canaryLine = CANARY;
    const { readLatestAssistantReply } = await import("../agents/tools/agent-step.js");
    vi.mocked(readLatestAssistantReply).mockResolvedValueOnce("A long report. ".repeat(60));
    await runIsolatedJob(job());
    const text = mocks.enqueueSystemEvent.mock.calls[0]![0] as string;
    expect(text.endsWith(`\n${CANARY}`)).toBe(true);
    expect(mocks.announced).toHaveBeenCalledWith("main");
  });

  it("records nothing when the send fails, when nothing is announced and when there is no reply", async () => {
    mocks.store = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 0,
        lastChannel: "telegram",
        lastTo: "12345",
      } as unknown as SessionEntry,
    };
    mocks.deliver.mockRejectedValueOnce(new Error("telegram is down"));
    await expect(runIsolatedJob(job())).rejects.toThrow("telegram is down");
    expect(mocks.announced).not.toHaveBeenCalled();

    mocks.store = {};
    mocks.beginJobAnnouncement.mockClear();
    await runIsolatedJob(job({ delivery: { mode: "none" } }));
    expect(mocks.beginJobAnnouncement).not.toHaveBeenCalled();

    const { readLatestAssistantReply } = await import("../agents/tools/agent-step.js");
    vi.mocked(readLatestAssistantReply).mockResolvedValueOnce("  ");
    await runIsolatedJob(job());
    expect(mocks.beginJobAnnouncement).not.toHaveBeenCalled();
    expect(mocks.announced).not.toHaveBeenCalled();
  });
});
