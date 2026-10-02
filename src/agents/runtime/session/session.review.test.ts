/**
 * Adversarial review of the owned session (PLAN-52). Each test states the
 * behaviour a production caller needs; a failing test is a finding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { isRunnerAbortError } from "../../embedded-runner/abort.js";
import { prepareSessionManagerForRun } from "../../embedded-runner/session-manager-init.js";
import { flushPendingToolResultsAfterIdle } from "../../embedded-runner/wait-for-idle-before-flush.js";
import { subscribeEmbeddedPiSession } from "../../embedded-subscribe.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { type ContractVariant, createContractSession, describeEvent } from "../contract/harness.js";
import {
  CONTRACT_API_KEY,
  CONTRACT_SESSION_ID,
  ScriptedModel,
  type ScriptStep,
} from "../contract/scripted-model.js";
import type { StreamFn } from "../loop/index.js";
import { openTranscript } from "../open-transcript.js";
import { AgentSession, type RequestAuthResult, type SessionStore } from "./session.js";
import { toRuntimeTools } from "./tools.js";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-review-"));
  roots.push(dir);
  return dir;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const text = (t: string, inputTokens?: number): ScriptStep => ({
  kind: "text",
  text: t,
  inputTokens,
});
const calls = (
  ...list: Array<[id: string, name: string, args?: Record<string, unknown>]>
): ScriptStep => ({
  kind: "tools",
  calls: list.map(([id, name, args]) => ({ id, name, args: args ?? {} })),
});
const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";

function tool(
  name: string,
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} } as AgentTool["parameters"],
    execute: async (_id, args, signal) => ({
      content: [{ type: "text", text: await execute(args as Record<string, unknown>, signal) }],
      details: {},
    }),
  };
}

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

function transcriptMessages(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as Record<string, unknown>);
}

/** The owned session, wired as owned-session.ts wires it, with overridable auth and stream function. */
async function ownedDirect(params: {
  script: ScriptedModel;
  tools?: AgentTool[];
  resolveRequestAuth?: () => Promise<RequestAuthResult>;
  streamFn?: StreamFn;
  retryBaseDelayMs?: number;
  keepRecentTokens?: number;
}) {
  const dir = tempDir();
  const file = path.join(dir, "session.jsonl");
  const cwd = path.join(dir, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const store = guardSessionManager(openTranscript(file, "bitterbot"), {
    agentId: "main",
    allowSyntheticToolResults: true,
  });
  await prepareSessionManagerForRun({
    sessionManager: store,
    sessionFile: file,
    hadSessionFile: false,
    sessionId: CONTRACT_SESSION_ID,
    cwd,
  });
  const baseStream: StreamFn = (model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: CONTRACT_API_KEY });
  const session = new AgentSession({
    model: params.script.model,
    thinkingLevel: "off",
    systemPrompt: "review",
    tools: toRuntimeTools(params.tools ?? []),
    store: store as unknown as SessionStore,
    settings: {
      retry: { enabled: true, maxRetries: 3, baseDelayMs: params.retryBaseDelayMs ?? 5 },
      compaction: {
        enabled: true,
        reserveTokens: 20_000,
        keepRecentTokens: params.keepRecentTokens ?? 20_000,
      },
    },
    streamFn: params.streamFn ?? baseStream,
    resolveRequestAuth:
      params.resolveRequestAuth ?? (async () => ({ ok: true, apiKey: CONTRACT_API_KEY })),
  });
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(describeEvent(event));
  });
  return { session, store, file, events, baseStream };
}

describe("review: a run must not start after abort() / dispose()", () => {
  it("abort() + dispose() while prompt() is in its preflight: no model call, no tool call", async () => {
    const ran: string[] = [];
    const script = new ScriptedModel([calls(["c1", "pay"]), text("done")]);
    let releaseAuth: () => void = () => {};
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const { session } = await ownedDirect({
      script,
      tools: [
        tool("pay", async () => {
          ran.push("pay");
          return "paid";
        }),
      ],
      // A slow key lookup (OAuth refresh, `!command` key). attempt.ts passes
      // modelRegistry.getApiKeyAndHeaders here.
      resolveRequestAuth: async () => {
        await authGate;
        return { ok: true, apiKey: CONTRACT_API_KEY };
      },
    });

    const running = session.prompt("pay the invoice");
    running.catch(() => {});
    // What attempt.ts does on a user stop or a timeout: abortRun() calls
    // session.abort(); the attempt then tears down (flush after idle, dispose).
    await session.abort();
    await flushPendingToolResultsAfterIdle({ agent: session.agent, sessionManager: undefined });
    session.dispose();

    releaseAuth();
    await sleep(200);
    await session.agent.waitForIdle();

    expect({ modelCalls: script.calls.length, toolsRun: ran }).toEqual({
      modelCalls: 0,
      toolsRun: [],
    });
  });

  // Verified during review: the "pi" variant fails this the same way.
  for (const variant of ["bitterbot"] as ContractVariant[]) {
    it(`${variant}: prompt() called after abort() (attempt.ts with a pre-aborted signal), then teardown`, async () => {
      const ran: string[] = [];
      const script = new ScriptedModel([calls(["c1", "pay"]), text("done")]);
      const s = await createContractSession({
        variant,
        dir: tempDir(),
        script,
        tools: [
          tool("pay", async () => {
            await sleep(20);
            ran.push("pay");
            return "paid";
          }),
        ],
      });
      // attempt.ts: `if (params.abortSignal.aborted) onAbort()` -> abortRun ->
      // `void activeSession.abort()`, and later still evaluates
      // `abortable(activeSession.prompt(...))`, which calls prompt().
      void s.session.abort();
      const running = s.session.prompt("pay the invoice");
      running.catch(() => {});
      await flushPendingToolResultsAfterIdle({ agent: s.session.agent, sessionManager: undefined });
      s.session.dispose();
      await sleep(300);
      await s.session.agent.waitForIdle();
      const persistedRoles = transcriptMessages(s.file).map((m) => String(m.role));
      expect({ modelCalls: script.calls.length, toolsRun: ran, persistedRoles }).toEqual({
        modelCalls: 0,
        toolsRun: [],
        persistedRoles: [],
      });
    });
  }

  it("abort() while an overflow compaction is in flight: the post-compaction retry does not run", async () => {
    const script = new ScriptedModel([
      text("first answer"),
      { kind: "error", message: OVERFLOW },
      text("SUMMARY"),
      text("retried answer"),
    ]);
    let releaseSummary: () => void = () => {};
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let call = 0;
    const slowSummary: StreamFn = async (model, context, options) => {
      call += 1;
      if (call === 3) {
        // The compaction summary call: slow, and (like a provider that does
        // not watch the signal) it completes anyway.
        await summaryGate;
      }
      return streamSimple(model, context, { ...options, apiKey: CONTRACT_API_KEY });
    };
    const { session, events } = await ownedDirect({
      script,
      streamFn: slowSummary,
      keepRecentTokens: 1,
    });
    await session.prompt("first question");
    const running = session.prompt("second question");
    running.catch(() => {});
    await waitFor(
      () => events.some((e) => e.startsWith("compaction_start overflow")),
      "compaction",
    );
    await waitFor(() => call === 3, "summary call");

    await session.abort(); // user stop; resolves, the session looks idle
    releaseSummary();
    await sleep(400);
    await session.agent.waitForIdle();

    // Nothing may run after abort() resolved.
    expect(script.calls.length).toBe(3);
    expect(events.filter((e) => e.includes("retried answer"))).toEqual([]);
    session.dispose();
  });
});

describe("review: tool registry", () => {
  // Verified during review: the "pi" variant passes this (its registry is a
  // Map by name, the later definition wins, the model is sent one "exec").
  for (const variant of ["bitterbot"] as ContractVariant[]) {
    it(`${variant}: two tools with one name (a client tool shadowing a server tool)`, async () => {
      const ran: string[] = [];
      const script = new ScriptedModel([calls(["c1", "exec"]), text("done")]);
      const s = await createContractSession({
        variant,
        dir: tempDir(),
        script,
        tools: [
          tool("exec", async () => {
            ran.push("server exec");
            return "server";
          }),
          // attempt.ts appends client (OpenResponses) tools after the server
          // tools; the name comes from the HTTP request.
          tool("exec", async () => {
            ran.push("client exec");
            return "client";
          }),
        ],
      });
      await s.prompt("go");
      await s.settle();
      expect({ sent: script.calls[0]?.tools, ran }).toEqual({
        sent: ["exec"],
        ran: ["client exec"],
      });
      await s.dispose();
    });
  }
});

describe("review: retry and persistence edge cases", () => {
  it("a stream function that throws a retryable error on the second turn is retried like on the first", async () => {
    const script = new ScriptedModel([
      calls(["c1", "noop"]),
      { kind: "throw", message: "503 service unavailable" },
      text("ok now"),
    ]);
    const { session, events } = await ownedDirect({
      script,
      tools: [tool("noop", async () => "ok")],
    });
    await session.prompt("go");
    expect(events.filter((e) => e.startsWith("auto_retry_start"))).toHaveLength(1);
    expect(script.remaining).toBe(0);
    session.dispose();
  });

  it("dispose() during a retry wait does not leave prompt() pending forever", async () => {
    const script = new ScriptedModel([{ kind: "error", message: "429 rate limit" }, text("never")]);
    const { session, events } = await ownedDirect({ script, retryBaseDelayMs: 50 });
    const running = session.prompt("go");
    await waitFor(() => events.some((e) => e.startsWith("auto_retry_start")), "retry start");
    session.dispose();
    const outcome = await Promise.race([
      running.then(
        () => "settled",
        () => "settled",
      ),
      sleep(1_000).then(() => "pending"),
    ]);
    expect(outcome).toBe("settled");
  });

  it("a transcript write that throws is reported to the caller", async () => {
    const script = new ScriptedModel([text("first answer"), text("the second answer")]);
    const { session, store, file, events } = await ownedDirect({ script });
    await session.prompt("first question");
    const append = store.appendMessage.bind(store);
    let failed = 0;
    store.appendMessage = ((message: Parameters<typeof append>[0]) => {
      if ((message as { role?: string }).role === "assistant") {
        failed += 1;
        throw new Error("ENOSPC: no space left on device");
      }
      return append(message);
    }) as typeof store.appendMessage;

    let rejected: unknown;
    await session.prompt("second question").catch((error: unknown) => {
      rejected = error;
    });
    expect(failed).toBe(1);
    // The model answered and the caller will deliver the answer, but the
    // transcript does not have it: the next turn starts without it.
    expect(transcriptMessages(file).map((m) => String(m.role))).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // Somebody has to be told: a rejection, or an event that carries the error.
    const reported = rejected !== undefined || events.some((e) => e.includes("ENOSPC"));
    expect(reported).toBe(true);
    session.dispose();
  });
});

describe("review: attempt.ts teardown order against the session", () => {
  it("abort during a retry wait with the context over the threshold: nothing is written after teardown", async () => {
    const script = new ScriptedModel([
      text("first answer", 170_000),
      { kind: "error", message: "429 rate limit" },
      text("SUMMARY"),
      text("never"),
    ]);
    let releaseSummary: () => void = () => {};
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let call = 0;
    const streamFn: StreamFn = async (model, context, options) => {
      call += 1;
      if (call === 3) {
        await summaryGate;
      }
      return streamSimple(model, context, { ...options, apiKey: CONTRACT_API_KEY });
    };
    const { session, store, file, events } = await ownedDirect({
      script,
      streamFn,
      retryBaseDelayMs: 2_000,
    });
    await session.prompt("first question");

    // The same structure as attempt.ts: abortable(), the subscriber, the
    // compaction wait, unsubscribe, flush after idle, dispose, lock release.
    const runAbortController = new AbortController();
    const abortable = <T>(promise: Promise<T>): Promise<T> => {
      const signal = runAbortController.signal;
      if (signal.aborted) {
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(err as Error);
          },
        );
      });
    };
    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "review-run",
    });
    const abortRun = () => {
      runAbortController.abort();
      void session.abort();
    };
    let linesAtRelease = -1;
    const attempt = (async () => {
      try {
        try {
          try {
            await abortable(session.prompt("x".repeat(120_000)));
          } catch {
            // promptError
          }
          try {
            await abortable(subscription.waitForCompactionRetry());
          } catch (err) {
            if (!isRunnerAbortError(err)) {
              throw err;
            }
          }
        } finally {
          subscription.unsubscribe();
        }
      } finally {
        await flushPendingToolResultsAfterIdle({ agent: session.agent, sessionManager: store });
        session.dispose();
        // sessionLock.release() happens here.
        linesAtRelease = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
      }
    })();

    await waitFor(() => events.some((e) => e.startsWith("auto_retry_start")), "retry wait");
    abortRun(); // the user's stop
    await attempt;
    const compactingAfterTeardown = session.isCompacting;
    releaseSummary();
    await sleep(500);
    const linesLater = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    const types = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);

    expect({
      compactingAfterTeardown,
      modelCalls: script.calls.length,
      writtenAfterLockRelease: linesLater - linesAtRelease,
      compactionEntries: types.filter((t) => t === "compaction").length,
    }).toEqual({
      compactingAfterTeardown: false,
      modelCalls: 2,
      writtenAfterLockRelease: 0,
      compactionEntries: 0,
    });
  });
});

describe("review: overflow recovery after a retried error", () => {
  // Verified during review: the "pi" variant fails this the same way.
  for (const variant of ["bitterbot"] as ContractVariant[]) {
    it(`${variant}: 429, retried, then context overflow: the turn is recovered or ends, it does not wedge`, async () => {
      const script = new ScriptedModel([
        text("first answer"),
        { kind: "error", message: "429 rate limit" },
        { kind: "error", message: OVERFLOW },
        text("SUMMARY"),
        text("recovered"),
      ]);
      const s = await createContractSession({
        variant,
        dir: tempDir(),
        script,
        compaction: { keepRecentTokens: 1 },
      });
      const subscription = subscribeEmbeddedPiSession({
        session: s.session as unknown as Parameters<
          typeof subscribeEmbeddedPiSession
        >[0]["session"],
        runId: `review-wedge-${variant}`,
      });
      await s.prompt("first question");
      await s.prompt("second question");
      // attempt.ts next awaits the subscriber's compaction-retry wait.
      const wait = await Promise.race([
        subscription.waitForCompactionRetry().then(() => "resolved"),
        sleep(1_500).then(() => "still waiting (until the run timeout)"),
      ]);
      const outcome = {
        wait,
        recovered: s.events.some((e) => e.includes('"recovered"')),
        lastMessage: s.messages().at(-1),
        scriptRemaining: script.remaining,
      };
      subscription.unsubscribe();
      await s.dispose();
      expect(outcome).toEqual({
        wait: "resolved",
        recovered: true,
        lastMessage: 'assistant[stop] "recovered"',
        scriptRemaining: 0,
      });
    });
  }
});
