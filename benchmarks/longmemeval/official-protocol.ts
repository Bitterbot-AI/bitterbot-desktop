/**
 * LongMemEval official protocol, as code.
 *
 * Everything here mirrors the reference implementation in
 * https://github.com/xiaowu0162/LongMemEval at commit 9e0b455f (2026-05-11):
 * `src/generation/run_generation.py` for the reader prompt and context
 * formatting, `src/evaluation/evaluate_qa.py` for the judge prompts and verdict
 * parsing, `src/evaluation/print_qa_metrics.py` for the aggregates, and the
 * README for which fields a memory system may see. Template strings are copied
 * verbatim; where Python formatting matters (json.dumps) it is reproduced.
 *
 * Pure functions only, so the protocol is unit-testable without a store.
 */

export const OFFICIAL_PROTOCOL_REF =
  "xiaowu0162/LongMemEval@9e0b455f4ef0e2ab8f2e582289761153549043fc";

// ── Dataset view ────────────────────────────────────────────────────────────

export type RawTurn = { role: string; content: string; has_answer?: boolean };

export type RawItem = {
  question_id: string;
  question_type: string;
  question: string;
  /** A string in 468 questions and an integer in 32; the judge sees str(answer). */
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: RawTurn[][];
  answer_session_ids: string[];
};

export type Turn = { role: string; content: string };

export type InferenceSession = {
  /** Opaque id assigned by position; never derived from the dataset's ids. */
  id: string;
  date: string;
  turns: Turn[];
};

/** What a memory system may see before it answers. Nothing else. */
export type InferenceItem = {
  question_id: string;
  question: string;
  question_date: string;
  sessions: InferenceSession[];
};

/** Evaluation-only companion: which opaque ids are gold. Built after search. */
export type GoldMap = {
  goldOpaqueIds: Set<string>;
  isAbstention: boolean;
};

export const OPAQUE_ID_PREFIX = "session-";

export function opaqueSessionId(index: number): string {
  return `${OPAQUE_ID_PREFIX}${String(index + 1).padStart(3, "0")}`;
}

/**
 * Strip every evaluation-only signal from a dataset item.
 *
 * Two leaks the official data carries (both documented in the repo's issues):
 * every turn of an evidence session has a `has_answer` key (true or false) and
 * no filler turn has one, so key presence marks gold; and every evidence
 * session id contains the substring "answer" by construction. Turns are
 * rebuilt with only role and content, and sessions get positional ids.
 * Sessions keep dataset order (the "online" order the history arrived in).
 */
export function toInferenceItem(item: RawItem): { inference: InferenceItem; gold: GoldMap } {
  const sessions: InferenceSession[] = item.haystack_sessions.map((turns, i) => ({
    id: opaqueSessionId(i),
    date: item.haystack_dates[i] ?? "",
    turns: turns.map((t) => ({ role: t.role, content: t.content })),
  }));
  const goldOpaqueIds = new Set<string>();
  const gold = new Set(item.answer_session_ids ?? []);
  for (let i = 0; i < item.haystack_session_ids.length; i++) {
    if (gold.has(item.haystack_session_ids[i]!)) {
      goldOpaqueIds.add(opaqueSessionId(i));
    }
  }
  return {
    inference: {
      question_id: item.question_id,
      question: item.question,
      question_date: item.question_date,
      sessions,
    },
    gold: { goldOpaqueIds, isAbstention: isAbstentionId(item.question_id) },
  };
}

/** evaluate_qa.py line 101: `abstention='_abs' in entry['question_id']`. */
export function isAbstentionId(questionId: string): boolean {
  return questionId.includes("_abs");
}

// ── Time ────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2}) \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) (\d{2}):(\d{2})$/;

/**
 * Parse the dataset's `%Y/%m/%d (%a) %H:%M` timestamps (no zone; treated as
 * UTC). Used as the memory system's "now" for the question and as each
 * session's creation time, so age-dependent scoring sees 2023 as 2023.
 */
export function parseLongMemEvalDate(s: string): number {
  const m = DATE_RE.exec(s.trim());
  if (!m) {
    throw new Error(`not a LongMemEval timestamp: ${JSON.stringify(s)}`);
  }
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

// ── Ingest format ───────────────────────────────────────────────────────────

/**
 * One document per session in the official `nl` history format
 * (run_generation.py L239: `"\n\n{}: {}".format(role, content.strip())`),
 * headed by the session date. A retrieved chunk of this file is therefore a
 * legitimate `nl`-format fragment of the session.
 */
export function sessionToNlDocument(session: InferenceSession): string {
  const parts = [`Session Date: ${session.date}`];
  for (const t of session.turns) {
    parts.push(`${t.role}: ${t.content.trim()}`);
  }
  return `${parts.join("\n\n")}\n`;
}

export function sessionFileName(session: InferenceSession): string {
  return `${session.id}.md`;
}

export function sessionIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

// ── Reader prompt ───────────────────────────────────────────────────────────

/** run_generation.py L55 (`--cot true`, the paper's default "Chain-of-Note"). */
export const READER_TEMPLATE_CON =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer (step by step):";

/** run_generation.py L57 (`--cot false`). */
export const READER_TEMPLATE_DIRECT =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer:";

export type Reading = "con" | "direct";
export type HistoryFormat = "json" | "nl";

/** Reader decoding in run_generation.py L360-L367 and the paper's Appendix D. */
export const READER_TEMPERATURE = 0;
export const READER_MAX_TOKENS = 800;

/**
 * Python's `json.dumps(obj)` with default arguments (`ensure_ascii=True`,
 * separators `", "` and `": "`) for a list of role/content turns, so the JSON
 * block the reader sees is byte-identical to the reference pipeline's.
 */
export function pythonJsonDumpsTurns(turns: Turn[]): string {
  const esc = (s: string): string => {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ch = s[i]!;
      if (ch === '"') {
        out += '\\"';
      } else if (ch === "\\") {
        out += "\\\\";
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else if (ch === "\b") {
        out += "\\b";
      } else if (ch === "\f") {
        out += "\\f";
      } else if (c >= 0x20 && c <= 0x7e) {
        out += ch;
      } else {
        out += `\\u${c.toString(16).padStart(4, "0")}`;
      }
    }
    return `${out}"`;
  };
  return `[${turns.map((t) => `{"role": ${esc(t.role)}, "content": ${esc(t.content)}}`).join(", ")}]`;
}

export type ContextItem = {
  date: string;
  /** Session unit: the session's turns. Chunk unit: the retrieved text. */
  turns?: Turn[];
  text?: string;
};

/**
 * run_generation.py L224-L259: items sorted by date string (zero-padded, so
 * lexical order is chronological), each rendered as
 * `\n### Session {i}:\nSession Date: {date}\nSession Content:\n{content}\n`
 * where content is `"\n" + json.dumps(turns)` for the `json` format or the
 * `nl` lines. Round-level items are also labelled "Session" in the reference.
 */
export function formatHistory(items: ContextItem[], format: HistoryFormat): string {
  const sorted = items.toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let history = "";
  sorted.forEach((item, i) => {
    let content: string;
    if (item.turns) {
      content =
        format === "json"
          ? `\n${pythonJsonDumpsTurns(item.turns)}`
          : item.turns.map((t) => `\n\n${t.role}: ${t.content.trim()}`).join("");
    } else {
      content = item.text ?? "";
    }
    history += `\n### Session ${i + 1}:\nSession Date: ${item.date}\nSession Content:\n${content}\n`;
  });
  return history;
}

export function buildReaderPrompt(params: {
  items: ContextItem[];
  questionDate: string;
  question: string;
  reading: Reading;
  format: HistoryFormat;
}): string {
  const template = params.reading === "con" ? READER_TEMPLATE_CON : READER_TEMPLATE_DIRECT;
  const history = formatHistory(params.items, params.format);
  // `template.format(history, question_date, question)`, positional.
  return fillPositional(template, [history, params.questionDate, params.question]);
}

function fillPositional(template: string, values: string[]): string {
  let i = 0;
  return template.replaceAll("{}", () => values[i++] ?? "");
}

// ── Judge ───────────────────────────────────────────────────────────────────

/** evaluate_qa.py L11-L15 model_zoo; print_qa_metrics.py asserts this id. */
export const OFFICIAL_JUDGE_MODEL = "gpt-4o-2024-08-06";
export const JUDGE_TEMPERATURE = 0;
export const JUDGE_MAX_TOKENS = 10;

const JUDGE_SHARED =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_TEMPORAL =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_KNOWLEDGE_UPDATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_ABSTENTION =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";

export const QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "temporal-reasoning",
  "knowledge-update",
  "multi-session",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** evaluate_qa.py `get_anscheck_prompt(task, question, answer, response, abstention)`. */
export function judgePrompt(params: {
  questionType: string;
  question: string;
  answer: string | number;
  hypothesis: string;
  abstention: boolean;
}): string {
  const answer = String(params.answer);
  let template: string;
  if (params.abstention) {
    template = JUDGE_ABSTENTION;
  } else {
    switch (params.questionType) {
      case "single-session-user":
      case "single-session-assistant":
      case "multi-session":
        template = JUDGE_SHARED;
        break;
      case "temporal-reasoning":
        template = JUDGE_TEMPORAL;
        break;
      case "knowledge-update":
        template = JUDGE_KNOWLEDGE_UPDATE;
        break;
      case "single-session-preference":
        template = JUDGE_PREFERENCE;
        break;
      default:
        throw new Error(`NotImplementedError: question_type ${params.questionType}`);
    }
  }
  return fillPositional(template, [params.question, answer, params.hypothesis]);
}

/** evaluate_qa.py L113: `label = 'yes' in eval_response.lower()`. */
export function parseJudgeLabel(response: string): boolean {
  return response.trim().toLowerCase().includes("yes");
}

// ── Aggregates ──────────────────────────────────────────────────────────────

export type Judged = { question_id: string; question_type: string; label: boolean };

export type Aggregates = {
  /** Question-weighted mean over everything judged (evaluate_qa.py "Accuracy"). */
  overall: { correct: number; n: number; accuracy: number };
  /** Per question_type, abstention items folded in (as the official script does). */
  byType: Record<string, { correct: number; n: number; accuracy: number }>;
  /** Mean of the six per-type accuracies (print_qa_metrics.py "task-averaged"). */
  taskAveraged: number;
  /** The `_abs` items on their own (print_qa_metrics.py "Abstention Accuracy"). */
  abstention: { correct: number; n: number; accuracy: number };
};

export function aggregate(judged: Judged[]): Aggregates {
  const byType: Aggregates["byType"] = {};
  let correct = 0;
  let absCorrect = 0;
  let absN = 0;
  for (const j of judged) {
    const t = (byType[j.question_type] ??= { correct: 0, n: 0, accuracy: 0 });
    t.n++;
    if (j.label) {
      t.correct++;
      correct++;
    }
    if (isAbstentionId(j.question_id)) {
      absN++;
      if (j.label) absCorrect++;
    }
  }
  const acc = (c: number, n: number) => (n ? Number((c / n).toFixed(4)) : 0);
  for (const t of Object.values(byType)) {
    t.accuracy = acc(t.correct, t.n);
  }
  const typeAccs = Object.values(byType).map((t) => t.accuracy);
  return {
    overall: { correct, n: judged.length, accuracy: acc(correct, judged.length) },
    byType,
    taskAveraged: typeAccs.length
      ? Number((typeAccs.reduce((a, b) => a + b, 0) / typeAccs.length).toFixed(4))
      : 0,
    abstention: { correct: absCorrect, n: absN, accuracy: acc(absCorrect, absN) },
  };
}

// ── Retrieval metrics ───────────────────────────────────────────────────────

/**
 * run_retrieval.py: recall_any@k (some gold item in the top k) and
 * recall_all@k (every gold item in the top k) over ranked session ids.
 * The official evaluation skips `_abs` questions for retrieval; callers do too.
 */
export function sessionRecall(
  rankedSessionIds: string[],
  gold: Set<string>,
  k: number,
): { any: number; all: number } {
  const top = new Set(rankedSessionIds.slice(0, k));
  let hit = 0;
  for (const g of gold) {
    if (top.has(g)) hit++;
  }
  return { any: hit > 0 ? 1 : 0, all: gold.size > 0 && hit === gold.size ? 1 : 0 };
}

/** The first `n` items of each question_type, keeping dataset order. */
export function firstPerType<T extends { question_type: string }>(dataset: T[], n: number): T[] {
  const taken = new Map<string, number>();
  return dataset.filter((item) => {
    const seen = taken.get(item.question_type) ?? 0;
    if (seen >= n) {
      return false;
    }
    taken.set(item.question_type, seen + 1);
    return true;
  });
}
