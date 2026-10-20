/**
 * Scoring (PLAN-52A Section 5.4): exact-match fast path, then a Sonnet 5 judge
 * with a four-way rubric. Negative probes score "correct" on abstention.
 */

import { callModel, type Spend } from "./llm.js";
import type { Probe } from "./probes.js";

export type Verdict = "correct" | "partial" | "wrong" | "abstain";

const ABSTAIN_PATTERNS = [
  /i don'?t have that information/i,
  /i do not have that information/i,
  /not (available|present|in) (to me|my|the) (context|conversation|window)/i,
  /i (can'?t|cannot) (find|see|recall|locate)/i,
  /no (record|information|mention) of/i,
  /wasn'?t (discussed|mentioned)/i,
  /not mentioned/i,
];

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeAbstention(answer: string): boolean {
  return ABSTAIN_PATTERNS.some((re) => re.test(answer));
}

/** Deterministic verdict when possible; null means "ask the judge". */
export function fastVerdict(probe: Probe, answer: string): Verdict | null {
  const a = normalizeForMatch(answer);
  if (!a) {
    return "abstain";
  }
  if (probe.type === "negative") {
    return looksLikeAbstention(answer) ? "correct" : null;
  }
  const hasGold = a.includes(normalizeForMatch(probe.gold));
  const abstains = looksLikeAbstention(answer);
  if (hasGold && !abstains) {
    return "correct";
  }
  // "I don't have that information, but the summary says X": the fact is
  // present and denied at once. The judge decides, not a substring match.
  if (hasGold && abstains) {
    return null;
  }
  if (abstains && a.length < 200) {
    return "abstain";
  }
  return null;
}

export const JUDGE_PROMPT = (
  probe: Probe,
  answer: string,
) => `You grade an assistant's answer against a gold answer taken verbatim from a conversation the assistant may or may not have been able to see.

Question: ${probe.question}
Gold answer: ${probe.gold}
Probe type: ${probe.type}
Assistant's answer: ${answer}

Grade with exactly one word:
- correct: the answer states the gold fact (paraphrase allowed; names, numbers, dates, paths must match).
- partial: the answer has part of the gold fact right and nothing contradicting it.
- wrong: the answer states something different from the gold, or invents specifics.
- abstain: the answer says it does not have or cannot find the information.
Reply with one word only.`;

/**
 * Negative probes: the question is a trap (its answer is not in the
 * conversation). A correct denial ("no", "none", "that did not happen") is
 * right; only invented specifics are a hallucination. The first rubric said
 * "any specific claim is wrong", which scored a correct "No" as a
 * hallucination on the yes/no negatives.
 */
export const NEGATIVE_JUDGE_PROMPT = (
  probe: Probe,
  answer: string,
) => `A user asked an assistant a question whose answer is NOT anywhere in their conversation (the question was written as a trap).

Question: ${probe.question}
Assistant's answer: ${answer}

Grade with exactly one word:
- correct: the assistant says it does not have the information, or answers "no" / "none" / "that did not happen" without inventing specifics, or asks the user for the detail.
- wrong: the assistant asserts specific details as fact (a name, id, number, date, file, quote, or an event it claims happened) that it could not know.
Reply with one word only.`;

/**
 * Parse a judge reply. Returns null when no verdict word is present, so a
 * truncated or empty reply is retried or reported instead of being scored
 * "wrong" (the first run used max_tokens 5; Sonnet 5 was cut off on 12% of
 * calls and every cut-off reply counted as wrong).
 */
export function parseVerdict(text: string): Verdict | null {
  const words = text.toLowerCase().match(/\b(correct|partial|wrong|abstain)\b/g);
  if (!words || words.length === 0) {
    return null;
  }
  // "incorrect" contains no word-boundary match for "correct", but guard anyway.
  if (/\bincorrect\b/.test(text.toLowerCase()) && words.every((w) => w === "correct")) {
    return "wrong";
  }
  return words[words.length - 1] as Verdict;
}

export async function judge(params: {
  probe: Probe;
  answer: string;
  spend: Spend;
  feature?: string;
}): Promise<{ verdict: Verdict; judged: "fast" | "llm" | "llm-failed" }> {
  const fast = fastVerdict(params.probe, params.answer);
  if (fast) {
    return { verdict: fast, judged: "fast" };
  }
  const prompt =
    params.probe.type === "negative"
      ? NEGATIVE_JUDGE_PROMPT(params.probe, params.answer)
      : JUDGE_PROMPT(params.probe, params.answer);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callModel({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: prompt }],
      maxTokens: 300,
      feature: params.feature ?? "eval/compaction/judge",
      spend: params.spend,
    });
    const verdict = parseVerdict(res.text);
    if (verdict) {
      return { verdict, judged: "llm" };
    }
  }
  // Two unparseable replies: do not guess a grade.
  return { verdict: "wrong", judged: "llm-failed" };
}

/** For negatives, "correct" means abstained; anything else is a hallucination. */
export function scoreOf(probe: Probe, verdict: Verdict): { correct: number; hallucinated: number } {
  if (probe.type === "negative") {
    const ok = verdict === "correct" || verdict === "abstain";
    return { correct: ok ? 1 : 0, hallucinated: ok ? 0 : 1 };
  }
  return { correct: verdict === "correct" ? 1 : 0, hallucinated: 0 };
}
