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
