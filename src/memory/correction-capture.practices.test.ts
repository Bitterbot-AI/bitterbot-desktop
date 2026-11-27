/**
 * PLAN-64 Phase 1: practices on the per-turn correction pass.
 *
 * Under test: the behavioural pre-filter patterns on the real phrasings
 * from the Phase 0 replay (and the ordinary chat that must not cost a model
 * call), the practices half of the prompt and its fail-closed parser, the
 * owner-tier rule (a majority of the statement's content words in the
 * owner's own prose, never in quoted or pasted text), the narrowest-scope
 * default, "everywhere", credential rejection, the single-call budget, the
 * disabled switch, owner stickiness through the shipped writer, and the
 * confirmation line.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalFactsStore } from "./canonical-facts.js";
import {
  describePracticeScope,
  formatMemoryUpdatedLine,
  isExplicitStandingInstruction,
  matchesCorrectionPrefilter,
  ownerProseSupportsStatement,
  type PracticeCaptureDeps,
  resolvePracticeScope,
  runCorrectionCapture,
} from "./correction-capture.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  type OwnerPinInput,
  pinFact,
  retirePractice,
  savePractice,
  type SavePracticeInput,
  setPracticeScope,
} from "./owner-controls.js";
import { PracticesStore } from "./practices.js";
import {
  buildCorrectionExtractionPrompt,
  parseCorrectionPractices,
  parseCorrectionResponse,
} from "./session-extractor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

const SESSION_KEY = "agent:plan64bot:main";
/** The owner's real message of 2026-11-27 (Phase 0 review). */
const DAY_BY_DAY = "Give me day by day clones and the npm downloads too";
const DAY_BY_DAY_PRACTICE = "For repo stats, give day by day clones and include the npm downloads.";

function llmReturning(json: unknown) {
  return vi.fn(async (_prompt: string, _opts?: { signal?: AbortSignal }) => JSON.stringify(json));
}

describe("behavioural pre-filter patterns (Phase 0 phrasings)", () => {
  it.each([
    // The real phrasings from the review doc.
    ["stop asking", "stop-verbing"],
    ["Stop asking me where I live.", "stop-verbing"],
    ["I told you already, please stop asking", "stop-verbing"],
    ["don't worry about the reputation score", "dont-worry-about"],
    ["Don’t worry about the reputation score", "dont-worry-about"],
    [DAY_BY_DAY, "give-too"],
    ["you should be better", "you-should"],
    // The same shapes in other words.
    ["Can you stop adding emojis?", "stop-verbing"],
    ["No need to worry about the forks", "dont-worry-about"],
    ["no need to include the full table", "no-need-to"],
    ["Include the views as well.", "give-too"],
    ["please show the traffic numbers every time", "give-too"],
    ["And add the npm downloads each time", "give-too"],
    ["You should check the docs before answering", "you-should"],
    ["you shouldn't ask me twice", "you-should"],
  ])("hits: %s", (text, name) => {
    expect(matchesCorrectionPrefilter(text)).toBe(name);
  });

  it.each([
    // The owner's real non-instructions (Phase 0 review): none may cost a call.
    "How many clones did your repo get yesterday?",
    "how did our npm's and clones do yesterday?",
    "Can you check npm, clones and views for yesterday for your repo?",
    "How did the repo do on clones and views yesterday?",
    "Can you check the latest stats?",
    "what's up my dude?",
    "Can you make me a cool fireworks display",
    "What is telematics?",
    "how about npm",
    "The message was unsolicited",
    // Narration and questions in the new shapes.
    "I had to stop working on it yesterday",
    "It won't stop raining here",
    "Should I stop using npm?",
    "When did they stop publishing the package?",
    "I don't worry about that kind of thing",
    "Is there no need to rebuild?",
    "no need to apologise",
    "That is too much, give me a minute",
    "Can you show me the logs?",
    "Give me the latest numbers",
    "What do you think you should do next?",
    "You should be able to see it now",
    "you should have received the email",
    "Do you think you should check again?",
  ])("misses: %s", (text) => {
    expect(matchesCorrectionPrefilter(text)).toBeNull();
  });

  it("reads past the channel's timestamp envelope (the real message, as the transcript holds it)", () => {
    // 2026-11-27: with the envelope in front, "Give me" was not at the start
    // of the text, the pattern missed, and the follow-up was not explicit.
    const real = "[Fri 2026-11-27 11:37 EST] Give me day by day clones and the npm downloads too";
    expect(matchesCorrectionPrefilter(real)).toBe("give-too");
    expect(isExplicitStandingInstruction(real)).toBe(true);
    expect(
      matchesCorrectionPrefilter("[Fri 2026-11-27 11:37 EST] Give me the latest numbers"),
    ).toBeNull();
  });

  it("never fires on quoted or pasted text", () => {
    expect(matchesCorrectionPrefilter("> stop asking\nthanks")).toBeNull();
    expect(matchesCorrectionPrefilter("```\nyou should check the docs\n```")).toBeNull();
  });
});

describe("the practices half of the correction prompt", () => {
  it("is absent unless asked for, and the facts prompt is unchanged without it", () => {
    const base = { userMessage: DAY_BY_DAY, assistantReply: "Here they are." };
    const plain = buildCorrectionExtractionPrompt(base);
    expect(plain).not.toContain("## Practices");
    expect(plain).not.toContain('"practices"');
    expect(buildCorrectionExtractionPrompt({ ...base, practices: false })).toBe(plain);
    const withPractices = buildCorrectionExtractionPrompt({ ...base, practices: true });
    expect(withPractices).toContain("## Practices");
    expect(withPractices).toContain('"practices":[{"statement"');
    expect(withPractices).toContain(`User: ${DAY_BY_DAY}`);
  });
});

describe("parseCorrectionPractices", () => {
  it("validates statement, scope hint and explicit flag; caps at three; dedupes", () => {
    const out = parseCorrectionPractices(
      JSON.stringify({
        facts: [],
        practices: [
          { statement: `  ${DAY_BY_DAY_PRACTICE} `, scope: "task", explicit: true },
          { statement: DAY_BY_DAY_PRACTICE.toUpperCase(), scope: "task", explicit: true },
          { statement: "Use British spelling for Acme.", scope: "Project: Acme", explicit: false },
          { statement: "Answer briefly on weekends.", scope: "weird:thing" },
          { statement: "A fourth practice that is over the cap." },
        ],
      }),
    );
    expect(out).toEqual([
      { statement: DAY_BY_DAY_PRACTICE, scope: "task", explicit: true },
      { statement: "Use British spelling for Acme.", scope: "project:acme", explicit: false },
      { statement: "Answer briefly on weekends.", scope: undefined, explicit: false },
    ]);
  });

  it("fails closed: garbage, a missing list, malformed entries and credentials yield nothing", () => {
    expect(parseCorrectionPractices("not json")).toEqual([]);
    expect(parseCorrectionPractices('{"facts":[]}')).toEqual([]);
    expect(parseCorrectionPractices('{"practices":"nope"}')).toEqual([]);
    expect(
      parseCorrectionPractices(
        JSON.stringify({
          practices: [
            null,
            "a string",
            { statement: 42 },
            { statement: "ok" },
            { statement: "Use the token sk-ant-REDACTED when deploying." },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("reads facts, practices and the follow-up from one fenced answer with prose after it", () => {
    // The shape claude-haiku-4-5 gives on this lane: a fenced object, then an explanation.
    const raw = `\`\`\`json
{"facts":[{"key":"infra.deploy_endpoint","value":"api2.acme.com","statement":"The deploy endpoint is api2.acme.com.","correction":true,"scope":"global"}],"practices":[{"statement":"${DAY_BY_DAY_PRACTICE}","scope":"task","explicit":true}],"follow_up":{"kind":"other"}}
\`\`\`

The user states an endpoint and one standing instruction. The follow-up is a new request {not a gap}.`;
    expect(parseCorrectionResponse(raw)).toEqual([
      {
        key: "infra.deploy_endpoint",
        value: "api2.acme.com",
        statement: "The deploy endpoint is api2.acme.com.",
        correction: true,
        scope: undefined,
      },
    ]);
    expect(parseCorrectionPractices(raw)).toEqual([
      { statement: DAY_BY_DAY_PRACTICE, scope: "task", explicit: true },
    ]);
    // Prose before the object, no fence.
    expect(
      parseCorrectionPractices(
        `Here is the result: {"facts":[],"practices":[{"statement":"${DAY_BY_DAY_PRACTICE}"}]} Hope that helps.`,
      ),
    ).toHaveLength(1);
  });

  it("a response with practices and no facts list still parses as no facts", () => {
    expect(
      parseCorrectionResponse('{"practices":[{"statement":"Give the numbers first."}]}'),
    ).toEqual([]);
  });
});

describe("ownerProseSupportsStatement", () => {
  it("needs more than half of the statement's content words in the owner's prose", () => {
    expect(ownerProseSupportsStatement(DAY_BY_DAY, DAY_BY_DAY_PRACTICE)).toBe(true);
    expect(
      ownerProseSupportsStatement("stop asking", "Stop asking the owner where they live."),
    ).toBe(false);
    expect(
      ownerProseSupportsStatement("Stop asking me where I live.", "Stop asking where I live."),
    ).toBe(true);
    // Something the owner never said.
    expect(
      ownerProseSupportsStatement(DAY_BY_DAY, "Always send a weekly summary by email on Mondays."),
    ).toBe(false);
  });

  it("does not count words that only appear in quoted, pasted or forwarded text", () => {
    const pasted = `thanks\n> ${DAY_BY_DAY}`;
    expect(ownerProseSupportsStatement(pasted, DAY_BY_DAY_PRACTICE)).toBe(false);
    expect(
      ownerProseSupportsStatement(`see this\n\`\`\`\n${DAY_BY_DAY}\n\`\`\``, DAY_BY_DAY_PRACTICE),
    ).toBe(false);
    expect(
      ownerProseSupportsStatement(`[Forwarded from Bob]\n${DAY_BY_DAY}`, DAY_BY_DAY_PRACTICE),
    ).toBe(false);
  });
});

describe("resolvePracticeScope: the narrowest scope the turn supports", () => {
  const base = { modelScope: "task", activeProject: null, userMessage: DAY_BY_DAY };

  it("job, then task, then a named project or person, then global", () => {
    expect(resolvePracticeScope({ ...base, cronJobId: "Job-7", taskSlug: "repo-stats" })).toBe(
      "job:job-7",
    );
    expect(resolvePracticeScope({ ...base, taskSlug: "repo-stats" })).toBe("task:repo-stats");
    expect(resolvePracticeScope(base)).toBe("global");
    // A project scope only for the active project the owner named.
    expect(
      resolvePracticeScope({
        modelScope: "project:acme",
        activeProject: "acme",
        userMessage: "For Acme, you should use British spelling",
      }),
    ).toBe("project:acme");
    expect(
      resolvePracticeScope({
        modelScope: "project:acme",
        activeProject: "acme",
        userMessage: "you should use British spelling",
      }),
    ).toBe("global");
    expect(
      resolvePracticeScope({
        modelScope: "project:globex",
        activeProject: "acme",
        userMessage: "For Globex, you should use British spelling",
      }),
    ).toBe("global");
    expect(
      resolvePracticeScope({
        modelScope: "person:alice",
        activeProject: null,
        userMessage: "For Alice, you should always cc her manager",
      }),
    ).toBe("person:alice");
  });

  it("'everywhere' forces global even when a task or job is known", () => {
    expect(
      resolvePracticeScope({
        ...base,
        userMessage: "Include the npm downloads too, everywhere",
        taskSlug: "repo-stats",
        cronJobId: "job-7",
      }),
    ).toBe("global");
  });
});

describe("runCorrectionCapture with practices", () => {
  let db: DatabaseSync;
  let facts: CanonicalFactsStore;
  let practices: PracticesStore;
  const pinAsOwner = async (input: OwnerPinInput) => pinFact(db, facts, input);

  beforeEach(() => {
    db = makeDb();
    facts = new CanonicalFactsStore(db);
    practices = new PracticesStore(db);
  });

  const deps = (over: Partial<PracticeCaptureDeps> = {}): PracticeCaptureDeps => ({
    save: async (input: SavePracticeInput) => savePractice(db, practices, input),
    store: practices,
    setScope: async (id, scope) => setPracticeScope(db, practices, id, scope),
    taskType: { slug: "repo-stats", label: "repo stats" },
    ...over,
  });

  const input = (over: Record<string, unknown> = {}) => ({
    cfg: {},
    sessionKey: SESSION_KEY,
    userMessage: DAY_BY_DAY,
    assistantReply: "Here is the day by day breakdown.",
    senderIsOwner: true,
    isHeartbeat: false,
    chatType: "direct",
    runStartedAt: Date.now() + 5,
    store: facts,
    pinAsOwner,
    practices: deps(),
    llmCall: llmReturning({
      facts: [],
      practices: [{ statement: DAY_BY_DAY_PRACTICE, scope: "task", explicit: true }],
    }),
    ...over,
  });

  it("stores an explicit instruction as an active owner practice at the task scope, with one call", async () => {
    const params = input();
    const res = await runCorrectionCapture(params);
    expect(res.prefilter).toBe("give-too");
    expect(res.llmCalls).toBe(1);
    expect(params.llmCall).toHaveBeenCalledTimes(1);
    expect(params.llmCall.mock.calls[0]![0]).toContain("## Practices");
    expect(res.practices).toEqual([
      {
        id: expect.any(String),
        statement: DAY_BY_DAY_PRACTICE,
        scope: "task:repo-stats",
        status: "active",
        op: "add",
        tier: "owner",
        taskLabel: "repo stats",
      },
    ]);
    expect(practices.list()).toMatchObject([
      { status: "active", source: "owner", scope: "task:repo-stats", origin: "explicit" },
    ]);
    expect(res.line).toBe(`Practice saved for repo stats: "${DAY_BY_DAY_PRACTICE}"`);
    const audit = db
      .prepare(`SELECT metadata FROM memory_audit_log WHERE event = 'practice_saved'`)
      .all() as Array<{ metadata: string }>;
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({ actor: "correction", status: "active" });
  });

  it("facts and practices come from the same single call", async () => {
    const params = input({
      userMessage: "No, the deploy endpoint is api2.acme.com. And include the npm downloads too.",
      llmCall: llmReturning({
        facts: [
          {
            key: "infra.deploy_endpoint",
            value: "api2.acme.com",
            statement: "The deploy endpoint is api2.acme.com.",
            correction: true,
          },
        ],
        practices: [{ statement: "Include the npm downloads.", scope: "task", explicit: true }],
      }),
    });
    const res = await runCorrectionCapture(params);
    expect(res.llmCalls).toBe(1);
    expect(res.writes).toHaveLength(1);
    expect(res.practices).toHaveLength(1);
    expect(res.line).toBe(
      'Memory updated: deploy endpoint = api2.acme.com; Practice saved for repo stats: "Include the npm downloads."',
    );
  });

  it("a practice the owner did not say, or the model did not call explicit, is a silent candidate", async () => {
    const inferred = await runCorrectionCapture(
      input({
        llmCall: llmReturning({
          practices: [
            { statement: "Always send a weekly summary by email on Mondays.", explicit: true },
            { statement: "Give day by day clones and npm downloads.", explicit: false },
          ],
        }),
      }),
    );
    expect(inferred.practices.map((p) => [p.status, p.tier])).toEqual([
      ["candidate", "extraction"],
      ["candidate", "extraction"],
    ]);
    expect(practices.list({ statuses: ["active"] })).toHaveLength(0);
    expect(inferred.line).toBeNull();
  });

  it("an instruction that only appears in pasted text never reaches the owner tier", async () => {
    const res = await runCorrectionCapture(
      input({ userMessage: `you should read this\n> ${DAY_BY_DAY}` }),
    );
    expect(res.practices).toMatchObject([{ status: "candidate", tier: "extraction" }]);
  });

  it("scope defaults: job with a cron context, global with neither task nor job", async () => {
    const job = await runCorrectionCapture(input({ practices: deps({ cronJobId: "job-7" }) }));
    expect(job.practices[0]).toMatchObject({ scope: "job:job-7" });
    expect(job.line).toBe(`Practice saved for this scheduled job: "${DAY_BY_DAY_PRACTICE}"`);

    const db2 = makeDb();
    const p2 = new PracticesStore(db2);
    const global = await runCorrectionCapture(
      input({
        store: new CanonicalFactsStore(db2),
        practices: { save: async (i: SavePracticeInput) => savePractice(db2, p2, i) },
      }),
    );
    expect(global.practices[0]).toMatchObject({ scope: "global" });
    expect(global.line).toBe(`Practice saved for everything: "${DAY_BY_DAY_PRACTICE}"`);
  });

  it("'everywhere' in the instruction stores it global despite the task type", async () => {
    const res = await runCorrectionCapture(
      input({
        userMessage: "Include the npm downloads too, everywhere",
        llmCall: llmReturning({
          practices: [{ statement: "Include the npm downloads.", scope: "global", explicit: true }],
        }),
      }),
    );
    expect(res.practices[0]).toMatchObject({ scope: "global", status: "active" });
  });

  it("a bare 'everywhere' right after widens the practice just saved in this session", async () => {
    // A real transcript: the evidence ref (what ties the practice to this
    // session) is only written when the transcript can be read.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan64-capture-"));
    const sessionFile = path.join(dir, "session-a.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        { role: "user", text: "How did the repo do on clones and views yesterday?" },
        { role: "assistant", text: "12 clones, 40 views." },
        { role: "user", text: DAY_BY_DAY },
      ]
        .map((l) => JSON.stringify({ type: "message", message: { role: l.role, content: l.text } }))
        .join("\n"),
    );
    await runCorrectionCapture(input({ sessionFile }));
    expect(practices.list()[0]).toMatchObject({
      scope: "task:repo-stats",
      evidenceRefs: [`session:${sessionFile}#L3`],
    });
    // In another session the same reply widens nothing (checked while the
    // practice is still narrow).
    const other = await runCorrectionCapture(
      input({
        sessionFile: path.join(dir, "session-b.jsonl"),
        userMessage: "apply that everywhere",
        // A scope-only "practice" from the model is dropped as well.
        llmCall: llmReturning({
          practices: [{ statement: "Apply that everywhere always.", explicit: true }],
        }),
      }),
    );
    expect(other.practices).toEqual([]);
    expect(practices.list()[0]).toMatchObject({ scope: "task:repo-stats" });
    const res = await runCorrectionCapture(
      input({
        sessionFile,
        userMessage: "apply that everywhere",
        // The model's own idea of a practice here is ignored.
        llmCall: llmReturning({
          practices: [{ statement: "Apply that everywhere always.", explicit: true }],
        }),
      }),
    );
    expect(res.practices).toMatchObject([{ op: "widen", scope: "global" }]);
    expect(practices.list()).toHaveLength(1);
    expect(practices.list()[0]).toMatchObject({ scope: "global", status: "active" });
    expect(practices.events(practices.list()[0]!.id).map((e) => e.kind)).toContain("widened");
    expect(res.line).toBe(`Practice now applies to everything: "${DAY_BY_DAY_PRACTICE}"`);
  });

  it("owner stickiness through the shipped writer: a retired practice is not re-created as a candidate", async () => {
    const first = await runCorrectionCapture(input());
    retirePractice(db, practices, first.practices[0]!.id);
    const inferred = await runCorrectionCapture(
      input({
        llmCall: llmReturning({
          practices: [{ statement: DAY_BY_DAY_PRACTICE, explicit: false }],
        }),
      }),
    );
    expect(inferred.practices).toEqual([]);
    expect(practices.list()).toMatchObject([{ status: "retired" }]);
    // The owner saying it again brings it back.
    const again = await runCorrectionCapture(input());
    expect(again.practices).toMatchObject([{ op: "promote", status: "active" }]);
  });

  it("a credential in a practice never lands and is never echoed", async () => {
    const res = await runCorrectionCapture(
      input({
        userMessage: "you should use the token sk-ant-REDACTED every time",
        llmCall: llmReturning({
          practices: [
            {
              statement: "Use the token sk-ant-REDACTED every time.",
              explicit: true,
            },
          ],
        }),
      }),
    );
    expect(res.practices).toEqual([]);
    expect(practices.list()).toHaveLength(0);
    expect(res.line).toBeNull();
  });

  it("memory.practices.enabled=false: no practices in the prompt, none stored, facts unaffected", async () => {
    const params = input({ cfg: { memory: { practices: { enabled: false } } } });
    const res = await runCorrectionCapture(params);
    expect(params.llmCall.mock.calls[0]![0]).not.toContain("## Practices");
    expect(res.practices).toEqual([]);
    expect(practices.list()).toHaveLength(0);
  });

  it("without practice deps the pass behaves as before (no practices section)", async () => {
    const params = input({ practices: null });
    const res = await runCorrectionCapture(params);
    expect(params.llmCall.mock.calls[0]![0]).not.toContain("## Practices");
    expect(res.practices).toEqual([]);
  });

  it("a pre-filter miss makes no call and stores nothing", async () => {
    const params = input({ userMessage: "How did the repo do on clones and views yesterday?" });
    const res = await runCorrectionCapture(params);
    expect(res.llmCalls).toBe(0);
    expect(params.llmCall).not.toHaveBeenCalled();
    expect(practices.list()).toHaveLength(0);
  });

  it("is skipped for guests, groups, subagents, cron sessions and heartbeats", async () => {
    for (const over of [
      { senderIsOwner: false },
      { isHeartbeat: true },
      { sessionKey: "agent:plan64bot:cron:job-7" },
      { sessionKey: "agent:plan64bot:subagent:abc" },
      { sessionKey: "agent:plan64bot:telegram:group:123" },
    ]) {
      const params = input(over);
      const res = await runCorrectionCapture(params);
      expect(res.skipped, JSON.stringify(over)).not.toBeNull();
      expect(params.llmCall).not.toHaveBeenCalled();
    }
    expect(practices.list()).toHaveLength(0);
  });
});

describe("the confirmation line for practices", () => {
  const practice = {
    id: "p1",
    statement: "Include the npm downloads.",
    scope: "task:repo-stats",
    status: "active" as const,
    op: "add" as const,
    tier: "owner" as const,
    taskLabel: "repo stats",
  };

  it("names the scope in plain words", () => {
    expect(describePracticeScope("task:repo-stats", "repo stats")).toBe("repo stats");
    expect(describePracticeScope("task:repo-stats")).toBe("repo stats");
    expect(describePracticeScope("project:acme-corp")).toBe("project acme corp");
    expect(describePracticeScope("person:alice")).toBe("alice");
    expect(describePracticeScope("job:abc")).toBe("this scheduled job");
    expect(describePracticeScope("global")).toBe("everything");
  });

  it("shows the statement in a direct chat and only a count elsewhere; candidates are not announced", () => {
    expect(formatMemoryUpdatedLine({ writes: [], held: [], practices: [practice] })).toBe(
      'Practice saved for repo stats: "Include the npm downloads."',
    );
    expect(
      formatMemoryUpdatedLine({ writes: [], held: [], practices: [practice], chatType: "group" }),
    ).toBe("Memory updated: 1 practice saved");
    expect(
      formatMemoryUpdatedLine({
        writes: [],
        held: [],
        practices: [{ ...practice, status: "candidate", tier: "extraction" }],
      }),
    ).toBeNull();
    const line = formatMemoryUpdatedLine({ writes: [], held: [], practices: [practice] })!;
    expect(line).not.toContain("—");
  });
});
