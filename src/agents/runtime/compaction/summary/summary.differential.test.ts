/**
 * PLAN-52 Phase 3: differential tests, our summary compaction vs
 * pi-coding-agent 0.73.1.
 *
 * Every function of the port runs next to pi's on the same synthetic
 * transcripts and the results must be equal. For the model calls both sides go
 * through pi-ai's `completeSimple` into a fake API provider (no network), and
 * the recorded requests (system prompt, prompt text, maxTokens, api key,
 * reasoning, headers, signal) must be equal too.
 *
 * `prepareCompaction` and `estimateContextTokens` are not exported from pi's
 * package index, so they are imported from the dist file by relative path.
 *
 * This file is deleted when the pi-coding-agent dependency goes (PLAN-52
 * Phase 5); `summary.test.ts` holds the tests that stay.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  registerApiProvider,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  calculateContextTokens as piCalculateContextTokens,
  compact as piCompact,
  convertToLlm as piConvertToLlm,
  DEFAULT_COMPACTION_SETTINGS as PI_DEFAULT_COMPACTION_SETTINGS,
  estimateTokens as piEstimateTokens,
  findCutPoint as piFindCutPoint,
  findTurnStartIndex as piFindTurnStartIndex,
  generateSummary as piGenerateSummary,
  getLastAssistantUsage as piGetLastAssistantUsage,
  serializeConversation as piSerializeConversation,
  type SessionEntry,
  shouldCompact as piShouldCompact,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CompactionPreparation as PiCompactionPreparation,
  estimateContextTokens as piEstimateContextTokens,
  prepareCompaction as piPrepareCompaction,
} from "../../../../../node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";
import { type ScriptStep, ScriptedModel } from "../../contract/scripted-model.js";
import { buildSessionContext } from "../../transcript/context.js";
import type { TranscriptEntry } from "../../transcript/types.js";
import {
  calculateContextTokens,
  compact,
  type CompactionPreparation,
  type CompactionSettings,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
  serializeConversation,
  type SessionMessage,
  shouldCompact,
  type SummaryThinkingLevel,
  toSessionMessage,
} from "./index.js";
import { SCENARIOS, usage } from "./test-fixtures.js";

const KEEP_BUDGETS = [1, 5, 12, 25, 40, 60, 100, 150, 250, 400, 1000, 5000, 20000];

function piEntries(entries: TranscriptEntry[]): SessionEntry[] {
  return entries as unknown as SessionEntry[];
}

function piMessages(messages: readonly SessionMessage[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

function settingsFor(keepRecentTokens: number, reserveTokens = 16384): CompactionSettings {
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/** Every message a scenario can put in front of the model, plus the raw entry messages. */
function allMessages(entries: TranscriptEntry[]): SessionMessage[] {
  const fromContext = buildSessionContext(entries).messages.map(toSessionMessage);
  const fromEntries = entries.flatMap((entry) =>
    entry.type === "message" ? [toSessionMessage(entry.message)] : [],
  );
  return [...fromContext, ...fromEntries];
}

/** A preparation with the file-operation sets as sorted lists, for readable diffs. */
function plainPreparation(
  preparation: CompactionPreparation | PiCompactionPreparation | undefined,
): unknown {
  if (!preparation) {
    return undefined;
  }
  return {
    ...preparation,
    fileOps: {
      read: [...preparation.fileOps.read],
      written: [...preparation.fileOps.written],
      edited: [...preparation.fileOps.edited],
    },
  };
}

const scripts: ScriptedModel[] = [];

function scripted(steps: ScriptStep[]): ScriptedModel {
  const script = new ScriptedModel(steps);
  scripts.push(script);
  return script;
}

afterEach(() => {
  for (const script of scripts.splice(0)) {
    script.dispose();
  }
});

const TWO_SUMMARIES: ScriptStep[] = [
  { kind: "text", text: "## Goal\nFirst scripted summary." },
  { kind: "text", text: "## Original Request\nSecond scripted summary." },
];

type CompactArgs = {
  apiKey?: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal?: AbortSignal;
  thinkingLevel?: SummaryThinkingLevel;
};

type Outcome = { result?: unknown; error?: string; calls: unknown[]; remaining: number };

async function runPiCompact(
  entries: TranscriptEntry[],
  settings: CompactionSettings,
  steps: ScriptStep[],
  args: CompactArgs = {},
): Promise<Outcome | undefined> {
  const preparation = piPrepareCompaction(piEntries(entries), settings);
  if (!preparation) {
    return undefined;
  }
  const script = scripted(steps);
  const outcome: Outcome = { calls: script.calls, remaining: 0 };
  try {
    outcome.result = await piCompact(
      preparation,
      script.model,
      args.apiKey as string,
      args.headers,
      args.customInstructions,
      args.signal,
      args.thinkingLevel,
    );
  } catch (err) {
    outcome.error = (err as Error).message;
  }
  outcome.remaining = script.remaining;
  return outcome;
}

async function runOurCompact(
  entries: TranscriptEntry[],
  settings: CompactionSettings,
  steps: ScriptStep[],
  args: CompactArgs = {},
): Promise<Outcome | undefined> {
  const preparation = prepareCompaction(entries, settings);
  if (!preparation) {
    return undefined;
  }
  const script = scripted(steps);
  const outcome: Outcome = { calls: script.calls, remaining: 0 };
  try {
    outcome.result = await compact(preparation, { model: script.model, ...args });
  } catch (err) {
    outcome.error = (err as Error).message;
  }
  outcome.remaining = script.remaining;
  return outcome;
}

describe("summary compaction vs pi: pure functions", () => {
  it("has the same default settings", () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual(PI_DEFAULT_COMPACTION_SETTINGS);
  });

  it("calculateContextTokens and shouldCompact agree", () => {
    const usages = [
      usage(0, 0),
      usage(100, 20),
      usage(100, 20, 30, 40),
      usage(100, 20, 30, 40, 0),
      usage(100, 20, 30, 40, 7),
    ];
    for (const u of usages) {
      expect(calculateContextTokens(u)).toBe(piCalculateContextTokens(u));
    }
    for (const enabled of [true, false]) {
      for (const contextTokens of [0, 183615, 183616, 183617, 200000]) {
        const settings = { enabled, reserveTokens: 16384, keepRecentTokens: 20000 };
        expect(shouldCompact(contextTokens, 200000, settings)).toBe(
          piShouldCompact(contextTokens, 200000, settings),
        );
      }
    }
  });

  for (const [name, build] of Object.entries(SCENARIOS)) {
    describe(name, () => {
      it("estimateTokens, estimateContextTokens, getLastAssistantUsage", () => {
        const entries = build();
        const messages = allMessages(entries);
        for (const message of messages) {
          expect(estimateTokens(message)).toBe(piEstimateTokens(message as AgentMessage));
        }
        const context = buildSessionContext(entries).messages.map(toSessionMessage);
        // Every prefix, so the "last usable usage" moves through the list.
        for (let end = 0; end <= context.length; end++) {
          const prefix = context.slice(0, end);
          expect(estimateContextTokens(prefix)).toEqual(
            piEstimateContextTokens(piMessages(prefix)),
          );
        }
        for (let end = 0; end <= entries.length; end++) {
          const prefix = entries.slice(0, end);
          expect(getLastAssistantUsage(prefix)).toEqual(piGetLastAssistantUsage(piEntries(prefix)));
        }
      });

      it("convertToLlm and serializeConversation", () => {
        const messages = allMessages(build());
        const ours = convertToLlm(messages);
        const theirs = piConvertToLlm(piMessages(messages));
        expect(ours).toEqual(theirs);
        expect(serializeConversation(ours)).toBe(piSerializeConversation(theirs));
        // One message at a time as well, so an empty line cannot hide a difference.
        for (const message of messages) {
          const one = convertToLlm([message]);
          expect(one).toEqual(piConvertToLlm(piMessages([message])));
          expect(serializeConversation(one)).toBe(piSerializeConversation(one as Message[]));
        }
      });

      it("findCutPoint over every range and budget", () => {
        const entries = build();
        for (let start = 0; start <= entries.length; start++) {
          for (let end = start; end <= entries.length; end++) {
            for (const keep of KEEP_BUDGETS) {
              expect(
                findCutPoint(entries, start, end, keep),
                `range ${start}..${end}, keep ${keep}`,
              ).toEqual(piFindCutPoint(piEntries(entries), start, end, keep));
            }
          }
        }
      });

      it("findTurnStartIndex from every entry and start", () => {
        const entries = build();
        for (let index = 0; index < entries.length; index++) {
          for (let start = 0; start <= index + 1; start++) {
            expect(findTurnStartIndex(entries, index, start), `entry ${index} from ${start}`).toBe(
              piFindTurnStartIndex(piEntries(entries), index, start),
            );
          }
        }
      });

      it("prepareCompaction for every budget, also on every path prefix", () => {
        const entries = build();
        for (let end = 0; end <= entries.length; end++) {
          const prefix = entries.slice(0, end);
          for (const keep of KEEP_BUDGETS) {
            const settings = settingsFor(keep);
            expect(
              plainPreparation(prepareCompaction(prefix, settings)),
              `prefix ${end}, keep ${keep}`,
            ).toEqual(plainPreparation(piPrepareCompaction(piEntries(prefix), settings)));
          }
        }
      });
    });
  }
});

describe("summary compaction vs pi: model calls", () => {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    it(`compact: ${name}, every budget`, async () => {
      for (const keep of KEEP_BUDGETS) {
        const settings = settingsFor(keep);
        const args: CompactArgs = { apiKey: "sk-fixture" };
        const theirs = await runPiCompact(build(), settings, TWO_SUMMARIES, args);
        const ours = await runOurCompact(build(), settings, TWO_SUMMARIES, args);
        expect(ours, `keep ${keep}`).toEqual(theirs);
      }
    });
  }

  it("compact: custom instructions, odd reserve, no api key", async () => {
    for (const name of ["plain", "splitTurn", "previousCompaction", "toolsAndFiles"]) {
      for (const keep of [1, 40, 150]) {
        const settings = settingsFor(keep, 12345);
        const args: CompactArgs = { customInstructions: "the database migration" };
        const theirs = await runPiCompact(SCENARIOS[name](), settings, TWO_SUMMARIES, args);
        const ours = await runOurCompact(SCENARIOS[name](), settings, TWO_SUMMARIES, args);
        expect(theirs, `${name}, keep ${keep}`).toBeDefined();
        expect(ours, `${name}, keep ${keep}`).toEqual(theirs);
      }
    }
  });

  it("covers the cases it claims to cover", async () => {
    const calls = (outcome: Outcome | undefined) =>
      (outcome?.calls ?? []) as Array<{ messages: string[]; maxTokens: number }>;
    const result = (outcome: Outcome | undefined) =>
      outcome?.result as {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details: { readFiles: string[]; modifiedFiles: string[] };
      };

    // No compaction yet: one call with the initial prompt.
    const plain = await runOurCompact(SCENARIOS.plain(), settingsFor(40), TWO_SUMMARIES);
    expect(calls(plain)).toHaveLength(1);
    expect(calls(plain)[0].messages[0]).toContain("The messages above are a conversation");
    expect(calls(plain)[0].maxTokens).toBe(13107);
    expect(result(plain).firstKeptEntryId).toBe("e6");

    // Previous compaction: the update prompt, and file lists carried forward.
    const prev = await runOurCompact(
      SCENARIOS.previousCompaction(),
      settingsFor(40),
      TWO_SUMMARIES,
    );
    expect(calls(prev)).toHaveLength(1);
    expect(calls(prev)[0].messages[0]).toContain("<previous-summary>\n## Goal\nEarlier work.");
    expect(result(prev).details).toEqual({
      readFiles: ["old/read.ts", "src/kept-read.ts"],
      modifiedFiles: ["old/both.ts", "old/mod.ts"],
    });
    const hook = await runOurCompact(
      SCENARIOS.previousCompactionFromHook(),
      settingsFor(40),
      TWO_SUMMARIES,
    );
    expect(result(hook).details).toEqual({
      readFiles: ["src/kept-read.ts"],
      modifiedFiles: ["old/both.ts"],
    });

    // Split turn: two calls, history first, with the two budgets.
    const split = await runOurCompact(SCENARIOS.splitTurn(), settingsFor(40), TWO_SUMMARIES);
    expect(calls(split).map((c) => c.maxTokens)).toEqual([13107, 8192]);
    expect(calls(split)[1].messages[0]).toContain("This is the PREFIX of a turn");
    expect(result(split).summary).toContain("\n\n---\n\n**Turn Context (split turn):**\n\n");
    expect(result(split).summary).toContain(
      "<modified-files>\ndb/driver.ts\ndb/migrate.sql\n</modified-files>",
    );

    // Split turn without earlier history: one call, the fixed history text.
    const alone = await runOurCompact(
      SCENARIOS.splitTurnNoHistory(),
      settingsFor(40),
      TWO_SUMMARIES,
    );
    expect(calls(alone)).toHaveLength(1);
    expect(result(alone).summary.startsWith("No prior history.\n\n---\n\n")).toBe(true);

    // The budget is reached on a tool result: the cut moves past it.
    const onResult = prepareCompaction(SCENARIOS.cutOnToolResult(), settingsFor(45));
    expect(onResult?.firstKeptEntryId).toBe("e6");
    expect(onResult?.isSplitTurn).toBe(true);
    // Nothing but a tool result after the budget point: everything is kept and
    // an empty conversation is summarized.
    const trailing = await runOurCompact(
      SCENARIOS.onlyToolResultAfter(),
      settingsFor(40),
      TWO_SUMMARIES,
    );
    expect(result(trailing).firstKeptEntryId).toBe("e0");
    expect(calls(trailing)[0].messages[0]).toContain("<conversation>\n\n</conversation>");

    // Settings entries before a user message turn the cut into a split turn.
    const quirk = prepareCompaction(SCENARIOS.settingsBeforeUser(), settingsFor(30));
    expect(quirk?.firstKeptEntryId).toBe("e2");
    expect(quirk?.isSplitTurn).toBe(true);
    expect(quirk?.messagesToSummarize).toHaveLength(0);
    expect(quirk?.turnPrefixMessages).toHaveLength(2);

    // Nothing to do.
    expect(prepareCompaction(SCENARIOS.empty(), settingsFor(40))).toBeUndefined();
    expect(prepareCompaction(SCENARIOS.endsWithCompaction(), settingsFor(40))).toBeUndefined();
  });

  it("compact: model errors give the same message", async () => {
    const cases: Array<{ name: string; keep: number; steps: ScriptStep[]; error: string }> = [
      {
        name: "plain",
        keep: 40,
        steps: [{ kind: "error", message: "boom" }],
        error: "Summarization failed: boom",
      },
      {
        name: "plain",
        keep: 40,
        steps: [{ kind: "error", message: "" }],
        error: "Summarization failed: Unknown error",
      },
      {
        name: "splitTurn",
        keep: 40,
        steps: [
          { kind: "error", message: "history down" },
          { kind: "text", text: "fine" },
        ],
        error: "Summarization failed: history down",
      },
      {
        name: "splitTurn",
        keep: 40,
        steps: [
          { kind: "text", text: "fine" },
          { kind: "error", message: "prefix down" },
        ],
        error: "Turn prefix summarization failed: prefix down",
      },
      {
        name: "splitTurnNoHistory",
        keep: 40,
        steps: [{ kind: "error", message: "" }],
        error: "Turn prefix summarization failed: Unknown error",
      },
      // The script runs out: the provider reports an error.
      {
        name: "plain",
        keep: 40,
        steps: [],
        error: "Summarization failed: contract script exhausted",
      },
      // The stream function throws: the error passes through unchanged.
      {
        name: "plain",
        keep: 40,
        steps: [{ kind: "throw", message: "no route" }],
        error: "no route",
      },
    ];
    for (const c of cases) {
      const settings = settingsFor(c.keep);
      const theirs = await runPiCompact(SCENARIOS[c.name](), settings, c.steps);
      const ours = await runOurCompact(SCENARIOS[c.name](), settings, c.steps);
      expect(theirs?.error, c.error).toBe(c.error);
      expect(ours).toEqual(theirs);
    }
  });

  it("compact: an aborted call is not an error (pi quirk)", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const name of ["plain", "splitTurn", "toolsAndFiles"]) {
      const settings = settingsFor(40);
      const args: CompactArgs = { signal: controller.signal };
      const theirs = await runPiCompact(SCENARIOS[name](), settings, TWO_SUMMARIES, args);
      const ours = await runOurCompact(SCENARIOS[name](), settings, TWO_SUMMARIES, args);
      expect(theirs?.error).toBeUndefined();
      expect(theirs?.remaining).toBe(2);
      expect(ours).toEqual(theirs);
    }
  });

  it("generateSummary: every prompt variant", async () => {
    const messages = buildSessionContext(SCENARIOS.toolsAndFiles()).messages.map(toSessionMessage);
    const variants: Array<{ customInstructions?: string; previousSummary?: string }> = [
      {},
      { customInstructions: "the failing test" },
      { previousSummary: "## Goal\nOld goal." },
      { customInstructions: "the failing test", previousSummary: "## Goal\nOld goal." },
      // Empty strings behave like "not given".
      { customInstructions: "", previousSummary: "" },
    ];
    for (const variant of variants) {
      for (const reserveTokens of [16384, 1001, 0]) {
        const theirScript = scripted([{ kind: "text", text: "scripted" }]);
        const theirs = await piGenerateSummary(
          piMessages(messages),
          theirScript.model,
          reserveTokens,
          "sk-fixture",
          undefined,
          undefined,
          variant.customInstructions,
          variant.previousSummary,
        );
        const ourScript = scripted([{ kind: "text", text: "scripted" }]);
        const ours = await generateSummary(messages, {
          model: ourScript.model,
          reserveTokens,
          apiKey: "sk-fixture",
          ...variant,
        });
        expect(ours).toBe(theirs);
        expect(ourScript.calls).toEqual(theirScript.calls);
        expect(ourScript.calls).toHaveLength(1);
      }
    }
  });
});

// A second fake provider that records the full request options, which the
// scripted model does not keep (reasoning, headers, signal).
const RECORDING_API = "bitterbot-summary-differential";

type RecordedRequest = {
  context: Context;
  maxTokens: number | undefined;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
  reasoning: string | undefined;
  signal: AbortSignal | undefined;
  optionKeys: string[];
};

const recorded = new Map<string, RecordedRequest[]>();
let recordingRegistered = false;
let recordingModels = 0;

function recordingModel(reasoning: boolean): { model: Model<Api>; requests: RecordedRequest[] } {
  if (!recordingRegistered) {
    recordingRegistered = true;
    const run = (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const requests = recorded.get(model.baseUrl) ?? [];
      recorded.set(model.baseUrl, requests);
      requests.push({
        context: {
          ...context,
          messages: context.messages.map((m) => ({ ...m, timestamp: 0 })),
        },
        maxTokens: options?.maxTokens,
        apiKey: options?.apiKey,
        headers: options?.headers,
        reasoning: options?.reasoning,
        signal: options?.signal,
        optionKeys: Object.keys(options ?? {}),
      });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        // Two text blocks and a thinking block: the summary joins the text with "\n".
        content: [
          { type: "text", text: `reply ${requests.length}, part one` },
          { type: "thinking", thinking: "not part of the summary" },
          { type: "text", text: "part two" },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(1, 1),
        stopReason: "stop",
        timestamp: 0,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    };
    registerApiProvider(
      { api: RECORDING_API, stream: run, streamSimple: run },
      "bitterbot-summary-differential",
    );
  }
  recordingModels += 1;
  const baseUrl = `https://summary-differential.invalid/${recordingModels}`;
  const requests: RecordedRequest[] = [];
  recorded.set(baseUrl, requests);
  return {
    requests,
    model: {
      id: "recording",
      name: "recording",
      api: RECORDING_API,
      provider: "summary-differential",
      baseUrl,
      reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_000,
    },
  };
}

describe("summary compaction vs pi: request options", () => {
  it("passes maxTokens, api key, headers, signal and reasoning the same way", async () => {
    const controller = new AbortController();
    const headers = { "x-fixture": "1" };
    const levels: Array<SummaryThinkingLevel | undefined> = [
      undefined,
      "off",
      "minimal",
      "high",
      "xhigh",
    ];
    for (const name of ["plain", "splitTurn", "previousCompaction"]) {
      for (const reasoning of [true, false]) {
        for (const thinkingLevel of levels) {
          const settings = settingsFor(40, 10000);
          const theirPreparation = piPrepareCompaction(piEntries(SCENARIOS[name]()), settings);
          const ourPreparation = prepareCompaction(SCENARIOS[name](), settings);
          if (!theirPreparation || !ourPreparation) {
            throw new Error(`no preparation for ${name}`);
          }
          const their = recordingModel(reasoning);
          const theirResult = await piCompact(
            theirPreparation,
            their.model,
            "sk-fixture",
            headers,
            "focus",
            controller.signal,
            thinkingLevel,
          );
          const our = recordingModel(reasoning);
          const ourResult = await compact(ourPreparation, {
            model: our.model,
            apiKey: "sk-fixture",
            headers,
            customInstructions: "focus",
            signal: controller.signal,
            thinkingLevel,
          });
          const label = `${name}, reasoning ${reasoning}, level ${thinkingLevel}`;
          expect(ourResult, label).toEqual(theirResult);
          expect(our.requests, label).toEqual(their.requests);
          expect(our.requests.length, label).toBeGreaterThan(0);
          for (const request of our.requests) {
            expect(request.signal).toBe(controller.signal);
            expect(request.headers).toBe(headers);
            expect(request.reasoning).toBe(
              reasoning && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined,
            );
          }
        }
      }
    }
  });
});
