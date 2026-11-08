/**
 * The owner's `## Your Current State` block reaches a CLI-backend turn only
 * when the turn says the owner is speaking (a channel turn routed to a CLI
 * provider can be a guest's).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const supervisorSpawnMock = vi.fn();
const promptParams: Array<{ selfState?: string }> = [];

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

// The memory-backed blocks would open a memory manager; not what is tested here.
vi.mock("./endocrine-state.js", () => ({ resolveEndocrineState: async () => undefined }));
vi.mock("./canonical-facts-block.js", () => ({
  resolveCanonicalFactsBlock: async () => undefined,
}));

vi.mock("./cli-runner/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-runner/helpers.js")>();
  return {
    ...actual,
    buildSystemPrompt: (params: Parameters<typeof actual.buildSystemPrompt>[0]) => {
      promptParams.push(params as { selfState?: string });
      return actual.buildSystemPrompt(params);
    },
  };
});

const { runCliAgent } = await import("./cli-runner.js");

async function run(senderIsOwner: boolean | undefined) {
  supervisorSpawnMock.mockResolvedValueOnce({
    runId: "run",
    pid: 1,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 5,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
    cancel: vi.fn(),
  });
  await runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: {},
    prompt: "what parts of you are on?",
    provider: "codex-cli",
    model: "gpt-5.2-codex",
    timeoutMs: 1_000,
    runId: "run-1",
    messageProvider: "telegram",
    senderIsOwner,
  });
  return promptParams.at(-1)?.selfState;
}

describe("CLI backend turns and the owner's state block", () => {
  beforeEach(() => {
    supervisorSpawnMock.mockReset();
    promptParams.length = 0;
  });

  it("is left out when the turn is a guest's or does not say", async () => {
    expect(await run(false)).toBeUndefined();
    expect(await run(undefined)).toBeUndefined();
  });

  it("is included on the owner's turn", async () => {
    expect(await run(true)).toMatch(/^## Your Current State/);
  });
});
