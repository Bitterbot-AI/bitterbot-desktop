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
${probe.type === "negative" ? "For a negative probe the gold is NOT IN TRANSCRIPT: abstain is the right behaviour; any specific claim is wrong." : ""}
Reply with one word only.`;

export async function judge(params: {
  probe: Probe;
  answer: string;
  spend: Spend;
}): Promise<{ verdict: Verdict; judged: "fast" | "llm" }> {
  const fast = fastVerdict(params.probe, params.answer);
  if (fast) {
    return { verdict: fast, judged: "fast" };
  }
  const res = await callModel({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: JUDGE_PROMPT(params.probe, params.answer) }],
    maxTokens: 5,
    feature: "eval/compaction/judge",
    spend: params.spend,
  });
  const word = res.text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const verdict: Verdict = word.startsWith("correct")
    ? "correct"
    : word.startsWith("partial")
      ? "partial"
      : word.startsWith("abstain")
        ? "abstain"
        : "wrong";
  return { verdict, judged: "llm" };
}

/** For negatives, "correct" means abstained; anything else is a hallucination. */
export function scoreOf(probe: Probe, verdict: Verdict): { correct: number; hallucinated: number } {
  if (probe.type === "negative") {
    const ok = verdict === "correct" || verdict === "abstain";
    return { correct: ok ? 1 : 0, hallucinated: ok ? 0 : 1 };
  }
  return { correct: verdict === "correct" ? 1 : 0, hallucinated: 0 };
}
