/**
 * LongMemEval answer judges, factored out of evaluate.ts so they can be imported
 * without triggering evaluate.ts's top-level CLI arg parsing (which would reject
 * an importing runner's own flags).
 */

/** GPT-4o judge, matching LongMemEval's official evaluation. Returns 1 or 0. */
export async function judgeAnswer(
  question: string,
  expected: string,
  hypothesis: string,
): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY required for LLM judge");
  }

  const prompt = `You are evaluating whether a chat assistant's answer is factually correct by comparing it to a ground-truth expected answer.

Question: ${question}
Expected Answer: ${expected}
Assistant's Answer: ${hypothesis}

Evaluation criteria:
- Score "correct" if the assistant's answer contains the same core facts as the expected answer
- Names, numbers, dates, and quantities must match (e.g., "$400,000" vs "$350,000" = incorrect)
- Paraphrasing, different wording, or additional detail is fine — only the core facts matter
- A verbose answer that includes the correct facts PLUS extra detail = correct
- A verbose answer that includes the correct facts BUT ALSO contradicts them = incorrect
- "I don't know" or refusal when the expected answer exists = incorrect
- For abstention questions where expected says info is insufficient: saying "I don't know" = correct
- If the assistant's answer directly contradicts the expected answer's key fact = incorrect

Reply with ONLY the word "correct" or "incorrect". Nothing else.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 10,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI judge error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const verdict = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
  // CRITICAL: .includes("correct") was matching "incorrect" as true.
  // Use strict equality or startsWith to prevent false positives.
  return verdict === "correct" || verdict.startsWith("correct") ? 1 : 0;
}

/** Substring/keyword heuristic judge (no LLM cost). Returns 1 or 0. */
export function heuristicJudge(expected: unknown, hypothesis: unknown): number {
  const exp = String((expected as string) ?? "")
    .toLowerCase()
    .trim();
  const hyp = String((hypothesis as string) ?? "")
    .toLowerCase()
    .trim();
  if (!exp || !hyp) {
    return 0;
  }

  // Exact or substring match
  if (hyp.includes(exp) || exp.includes(hyp)) {
    return 1;
  }

  // Check if all key words from expected appear in hypothesis
  const expWords = exp.split(/\s+/).filter((w) => w.length > 3);
  const matchedWords = expWords.filter((w) => hyp.includes(w));
  if (expWords.length > 0 && matchedWords.length / expWords.length >= 0.7) {
    return 1;
  }

  return 0;
}
