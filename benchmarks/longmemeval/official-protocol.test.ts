import { describe, expect, it } from "vitest";
import {
  aggregate,
  buildReaderPrompt,
  firstPerType,
  formatHistory,
  isAbstentionId,
  judgePrompt,
  OFFICIAL_JUDGE_MODEL,
  parseJudgeLabel,
  parseLongMemEvalDate,
  pythonJsonDumpsTurns,
  type RawItem,
  sessionRecall,
  sessionToNlDocument,
  toInferenceItem,
} from "./official-protocol.js";

const item: RawItem = {
  question_id: "gpt4_70e84552_abs",
  question_type: "multi-session",
  question: "What did I name my dog?",
  answer: 42,
  question_date: "2023/05/20 (Sat) 02:21",
  haystack_dates: ["2023/04/10 (Mon) 23:07", "2023/04/10 (Mon) 17:50", "2023/05/01 (Mon) 09:00"],
  haystack_session_ids: ["sharegpt_1", "answer_abc_1", "answer_abc_2"],
  haystack_sessions: [
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    [
      { role: "user", content: "I named my dog Biscuit", has_answer: true },
      { role: "assistant", content: "Nice name", has_answer: false },
    ],
    [{ role: "user", content: 'café ☕ "quoted"\nline', has_answer: false }],
  ],
  answer_session_ids: ["answer_abc_1", "answer_abc_2"],
};

describe("toInferenceItem", () => {
  it("strips has_answer and every dataset session id from the inference view", () => {
    const { inference, gold } = toInferenceItem(item);
    const dump = JSON.stringify(inference);
    expect(dump).not.toContain("has_answer");
    expect(dump).not.toContain("answer_");
    expect(dump).not.toContain("sharegpt");
    expect(inference.sessions.map((s) => s.id)).toEqual([
      "session-001",
      "session-002",
      "session-003",
    ]);
    // Dataset order is kept (the online order); the reader sorts by date later.
    expect(inference.sessions[0]!.date).toBe("2023/04/10 (Mon) 23:07");
    expect(gold.goldOpaqueIds).toEqual(new Set(["session-002", "session-003"]));
    expect(gold.isAbstention).toBe(true);
  });

  it("writes every turn into the nl document with its date header", () => {
    const { inference } = toInferenceItem(item);
    const doc = sessionToNlDocument(inference.sessions[1]!);
    expect(doc).toBe(
      "Session Date: 2023/04/10 (Mon) 17:50\n\nuser: I named my dog Biscuit\n\nassistant: Nice name\n",
    );
  });
});

describe("parseLongMemEvalDate", () => {
  it("parses the dataset format as UTC", () => {
    expect(parseLongMemEvalDate("2023/05/20 (Sat) 02:21")).toBe(Date.UTC(2023, 4, 20, 2, 21));
  });
  it("rejects anything else", () => {
    expect(() => parseLongMemEvalDate("2023-05-20")).toThrow();
  });
});

describe("reader prompt", () => {
  it("reproduces python json.dumps for the turn list", () => {
    expect(
      pythonJsonDumpsTurns(
        item.haystack_sessions[2]!.map((t) => ({ role: t.role, content: t.content })),
      ),
    ).toBe('[{"role": "user", "content": "caf\\u00e9 \\u2615 \\"quoted\\"\\nline"}]');
  });

  it("matches run_generation.py formatting: date-sorted sessions, CoN template, raw question_date", () => {
    const prompt = buildReaderPrompt({
      items: [
        { date: "2023/04/10 (Mon) 23:07", turns: [{ role: "user", content: "b" }] },
        { date: "2023/04/10 (Mon) 17:50", turns: [{ role: "user", content: "a" }] },
      ],
      questionDate: "2023/05/20 (Sat) 02:21",
      question: "Q?",
      reading: "con",
      format: "json",
    });
    expect(prompt).toBe(
      "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n" +
        '\n### Session 1:\nSession Date: 2023/04/10 (Mon) 17:50\nSession Content:\n\n[{"role": "user", "content": "a"}]\n' +
        '\n### Session 2:\nSession Date: 2023/04/10 (Mon) 23:07\nSession Content:\n\n[{"role": "user", "content": "b"}]\n' +
        "\n\nCurrent Date: 2023/05/20 (Sat) 02:21\nQuestion: Q?\nAnswer (step by step):",
    );
  });

  it("renders chunk text as-is for the nl unit and the direct template ends with Answer:", () => {
    const history = formatHistory([{ date: "2023/04/10 (Mon) 17:50", text: "user: a" }], "nl");
    expect(history).toBe(
      "\n### Session 1:\nSession Date: 2023/04/10 (Mon) 17:50\nSession Content:\nuser: a\n",
    );
    const prompt = buildReaderPrompt({
      items: [],
      questionDate: "d",
      question: "q",
      reading: "direct",
      format: "nl",
    });
    expect(prompt.endsWith("\nCurrent Date: d\nQuestion: q\nAnswer:")).toBe(true);
    expect(prompt).not.toContain("step by step");
  });
});

describe("judge", () => {
  it("pins the official judge snapshot", () => {
    expect(OFFICIAL_JUDGE_MODEL).toBe("gpt-4o-2024-08-06");
  });

  it("selects the abstention template from the id alone and stringifies integer answers", () => {
    const p = judgePrompt({
      questionType: "multi-session",
      question: "Q",
      answer: 42,
      hypothesis: "H",
      abstention: isAbstentionId("x_abs"),
    });
    expect(p.startsWith("I will give you an unanswerable question, an explanation")).toBe(true);
    expect(p).toContain("\n\nExplanation: 42\n\n");
    expect(
      p.endsWith(
        "Does the model correctly identify the question as unanswerable? Answer yes or no only.",
      ),
    ).toBe(true);
  });

  it("uses the per-type templates", () => {
    const base = { question: "Q", answer: "A", hypothesis: "H", abstention: false };
    expect(judgePrompt({ ...base, questionType: "temporal-reasoning" })).toContain(
      "do not penalize off-by-one errors",
    );
    expect(judgePrompt({ ...base, questionType: "knowledge-update" })).toContain(
      "previous information along with an updated answer",
    );
    expect(judgePrompt({ ...base, questionType: "single-session-preference" })).toContain(
      "Rubric: A",
    );
    expect(judgePrompt({ ...base, questionType: "single-session-assistant" })).toContain(
      "Correct Answer: A",
    );
    expect(() => judgePrompt({ ...base, questionType: "unknown" })).toThrow(/NotImplementedError/);
  });

  it("parses the verdict as a substring test like the reference", () => {
    expect(parseJudgeLabel("Yes")).toBe(true);
    expect(parseJudgeLabel("yes.")).toBe(true);
    expect(parseJudgeLabel("No")).toBe(false);
    expect(parseJudgeLabel("")).toBe(false);
  });
});

describe("aggregates", () => {
  it("reports question-weighted, task-averaged and abstention accuracy", () => {
    const agg = aggregate([
      { question_id: "a", question_type: "multi-session", label: true },
      { question_id: "b", question_type: "multi-session", label: false },
      { question_id: "c_abs", question_type: "multi-session", label: true },
      { question_id: "d", question_type: "knowledge-update", label: false },
    ]);
    expect(agg.overall).toEqual({ correct: 2, n: 4, accuracy: 0.5 });
    expect(agg.byType["multi-session"]).toEqual({ correct: 2, n: 3, accuracy: 0.6667 });
    expect(agg.byType["knowledge-update"]).toEqual({ correct: 0, n: 1, accuracy: 0 });
    expect(agg.taskAveraged).toBe(0.3333);
    expect(agg.abstention).toEqual({ correct: 1, n: 1, accuracy: 1 });
  });
});

describe("retrieval helpers", () => {
  it("computes recall_any and recall_all over ranked sessions", () => {
    const gold = new Set(["s2", "s9"]);
    expect(sessionRecall(["s1", "s2", "s3"], gold, 3)).toEqual({ any: 1, all: 0 });
    expect(sessionRecall(["s9", "s2"], gold, 2)).toEqual({ any: 1, all: 1 });
    expect(sessionRecall(["s1"], gold, 5)).toEqual({ any: 0, all: 0 });
  });

  it("takes the first n of each type in dataset order", () => {
    const rows = [
      { question_type: "a", i: 1 },
      { question_type: "b", i: 2 },
      { question_type: "a", i: 3 },
      { question_type: "a", i: 4 },
    ];
    expect(firstPerType(rows, 2).map((r) => r.i)).toEqual([1, 2, 3]);
  });
});
