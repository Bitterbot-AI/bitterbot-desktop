/**
 * Probe generation and filtering (PLAN-52A Section 5.2).
 *
 * Probes are generated from the ELIDED range only. A probe survives only if
 * its gold answer appears verbatim in the elided text (verifiable) and not in
 * the kept region (no leakage). Each probe is tagged with whether the gold
 * appears in user/assistant dialogue (answerable by memory_search in
 * production) or only in a tool output.
 */

import type { PolicyEntry } from "../../src/agents/runtime/compaction/types.js";
import { callModel, type EvalModel, type Spend } from "./llm.js";
import { serializeEntries } from "./messages.js";

export type ProbeType = "fact" | "instruction" | "task_state" | "tool_output" | "negative";

export type Probe = {
  probeId: string;
  cutId: string;
  type: ProbeType;
  question: string;
  gold: string;
  sourceEntryId: string | null;
  /** Gold text appears in user/assistant dialogue of the elided range. */
  answerableFromDialogue: boolean;
  /** Gold text appears only in a tool output of the elided range. */
  needsToolOutput: boolean;
};

export const PROBE_GENERATION_PROMPT = `You write evaluation probes for an assistant that will continue the conversation below WITHOUT seeing it (it was moved out of the context window). Produce 8 to 10 probes as a JSON array. Each probe is an object:
{"type": "fact" | "instruction" | "task_state" | "tool_output" | "negative", "question": "...", "gold": "...", "source_entry_id": "e..." | null}

Rules:
- "fact": asks for a specific name, number, date, path, URL or decision stated by the user or the assistant. "gold" must be a short verbatim phrase (3 to 12 words) copied exactly from the text, so it can be string-matched.
- "instruction": a constraint or preference the user stated (how to write, what to avoid, which path to use). Question form: "What did I ask you to do/avoid regarding ...?" "gold" is the verbatim constraint phrase.
- "task_state": "What was I asking you to do right before this?" style; "gold" is a verbatim phrase from the last user request in the range.
- "tool_output": a value that appears ONLY inside a [Tool ...] block (file content, command output, a number from a result). "gold" is a verbatim token or short phrase from that block. Include 2 of these only if tool blocks exist.
- "negative": a plausible question whose answer is NOT in the conversation at all. "gold" is "NOT IN TRANSCRIPT".
- Phrase every question the way the same user would ask it later in the same chat, in the first person ("what was the ...", "which file did you ...").
- Mix: at least 3 fact, 1 to 2 instruction, 1 task_state, up to 2 tool_output, exactly 2 negative.
- Output ONLY the JSON array.`;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function textOf(entries: readonly PolicyEntry[], roles: readonly string[]): string {
  return normalize(
    entries
      .filter((e) => roles.includes(e.role))
      .map((e) => e.text)
      .join("\n"),
  );
}

/** Verify and tag generated probes against the elided and kept text. Pure. */
export function filterProbes(
  raw: Array<{ type?: unknown; question?: unknown; gold?: unknown; source_entry_id?: unknown }>,
  elided: readonly PolicyEntry[],
  kept: readonly PolicyEntry[],
  cutId: string,
): { probes: Probe[]; rejected: Array<{ reason: string; probe: unknown }> } {
  const elidedDialogue = textOf(elided, ["user", "assistant"]);
  const elidedTools = textOf(elided, ["toolResult"]);
  const keptAll = textOf(kept, ["user", "assistant", "toolResult"]);
  const probes: Probe[] = [];
  const rejected: Array<{ reason: string; probe: unknown }> = [];
  const types: ProbeType[] = ["fact", "instruction", "task_state", "tool_output", "negative"];
  let n = 0;
  for (const p of raw) {
    const type = p.type as ProbeType;
    const question = typeof p.question === "string" ? p.question.trim() : "";
    const gold = typeof p.gold === "string" ? p.gold.trim() : "";
    if (!types.includes(type) || !question || !gold) {
      rejected.push({ reason: "malformed", probe: p });
      continue;
    }
    if (type === "negative") {
      probes.push({
        probeId: `${cutId}-p${++n}`,
        cutId,
        type,
        question,
        gold: "NOT IN TRANSCRIPT",
        sourceEntryId: null,
        answerableFromDialogue: false,
        needsToolOutput: false,
      });
      continue;
    }
    const g = normalize(gold);
    if (g.length < 3) {
      rejected.push({ reason: "gold too short", probe: p });
      continue;
    }
    const inDialogue = elidedDialogue.includes(g);
    const inTools = elidedTools.includes(g);
    if (!inDialogue && !inTools) {
      rejected.push({ reason: "gold not verbatim in elided range", probe: p });
      continue;
    }
    if (keptAll.includes(g)) {
      rejected.push({ reason: "gold leaks into kept region", probe: p });
      continue;
    }
    probes.push({
      probeId: `${cutId}-p${++n}`,
      cutId,
      type,
      question,
      gold,
      sourceEntryId:
        typeof p.source_entry_id === "string" ? p.source_entry_id.replace(/^e/, "") : null,
      answerableFromDialogue: inDialogue,
      needsToolOutput: !inDialogue && inTools,
    });
  }
  return { probes, rejected };
}

export function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function generateProbes(params: {
  cutId: string;
  elided: readonly PolicyEntry[];
  kept: readonly PolicyEntry[];
  spend: Spend;
  model?: EvalModel;
}): Promise<{ probes: Probe[]; rejected: Array<{ reason: string; probe: unknown }> }> {
  // Keep the generator input bounded: dialogue in full, tool outputs capped.
  const text = serializeEntries(params.elided, { toolMaxChars: 1_500, withIds: true });
  const bounded =
    text.length > 240_000
      ? `${text.slice(0, 240_000)}\n[... range truncated for probe generation ...]`
      : text;
  const res = await callModel({
    model: params.model ?? "claude-haiku-4-5",
    messages: [
      {
        role: "user",
        content: `${PROBE_GENERATION_PROMPT}\n\n<conversation>\n${bounded}\n</conversation>`,
      },
    ],
    maxTokens: 2_500,
    feature: "eval/compaction/probe-generation",
    spend: params.spend,
  });
  const raw = parseJsonArray(res.text) as Array<Record<string, unknown>>;
  return filterProbes(raw, params.elided, params.kept, params.cutId);
}

export const NEGATIVE_GENERATION_PROMPT = `You write trap questions for an assistant that is continuing the conversation below. Each trap asks about a SPECIFIC named thing that is NOT mentioned anywhere in the conversation, but that would sound plausible to someone who had not read it carefully (a file name, a person, a product, a number, a date, a decision, an error message).

Produce 5 traps as a JSON array of objects:
{"question": "...", "key_terms": ["...", "..."]}

Rules:
- Start every question with What, Which, Who, When, Where or How many. Never a yes/no question.
- Phrase it in the first person, the way the same user would ask later in the same chat.
- "key_terms": the 1 to 3 specific strings (names, identifiers, numbers) that would HAVE to appear in the conversation if the thing had been discussed. They must not appear in the conversation.
- Do not ask about things that are in the conversation.
- Output ONLY the JSON array.`;

/**
 * Round 2 negatives: a trap survives only if none of its key terms occurs in
 * the whole transcript the agent could reach (every role, kept and elided),
 * and the question is not a yes/no question. Pure; exported for tests.
 */
export function filterVerifiedNegatives(
  raw: Array<{ question?: unknown; key_terms?: unknown }>,
  fullTranscriptLower: string,
  cutId: string,
  max = 2,
): { probes: Probe[]; rejected: Array<{ reason: string; probe: unknown }> } {
  const probes: Probe[] = [];
  const rejected: Array<{ reason: string; probe: unknown }> = [];
  for (const p of raw) {
    const question = typeof p.question === "string" ? p.question.trim() : "";
    const terms = Array.isArray(p.key_terms)
      ? p.key_terms.filter((t): t is string => typeof t === "string" && t.trim().length >= 3)
      : [];
    if (!question || terms.length === 0) {
      rejected.push({ reason: "malformed", probe: p });
      continue;
    }
    if (!/^(what|which|who|when|where|how many|how much)\b/i.test(question)) {
      rejected.push({ reason: "not a wh-question", probe: p });
      continue;
    }
    const present = terms.find((t) => fullTranscriptLower.includes(t.trim().toLowerCase()));
    if (present) {
      rejected.push({ reason: `key term present in transcript: ${present}`, probe: p });
      continue;
    }
    if (probes.length >= max) {
      continue;
    }
    probes.push({
      probeId: `${cutId}-n${probes.length + 1}`,
      cutId,
      type: "negative",
      question,
      gold: "NOT IN TRANSCRIPT",
      sourceEntryId: null,
      answerableFromDialogue: false,
      needsToolOutput: false,
    });
  }
  return { probes, rejected };
}

export async function generateVerifiedNegatives(params: {
  cutId: string;
  /** Text shown to the generator (the conversation so far, tool outputs capped). */
  conversation: string;
  /** Lowercased text of everything reachable, for the absence check. */
  fullTranscriptLower: string;
  spend: Spend;
}): Promise<{ probes: Probe[]; rejected: Array<{ reason: string; probe: unknown }> }> {
  const bounded =
    params.conversation.length > 200_000
      ? `${params.conversation.slice(0, 200_000)}\n[... truncated ...]`
      : params.conversation;
  const res = await callModel({
    model: "claude-haiku-4-5",
    messages: [
      {
        role: "user",
        content: `${NEGATIVE_GENERATION_PROMPT}\n\n<conversation>\n${bounded}\n</conversation>`,
      },
    ],
    maxTokens: 1_200,
    feature: "eval/compaction/negative-generation",
    spend: params.spend,
  });
  const raw = parseJsonArray(res.text) as Array<Record<string, unknown>>;
  return filterVerifiedNegatives(raw, params.fullTranscriptLower, params.cutId);
}
