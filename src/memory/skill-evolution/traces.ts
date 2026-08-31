/**
 * PLAN-42 Phase 1: trace reconstruction from the event journal.
 *
 * Turns a `run_id` into an ordered trajectory — assistant text, tool calls
 * with args, tool results with error flags, terminal lifecycle outcome —
 * ready for the Wiki Maintainer / Skill Proposer prompts. Three invariants:
 *
 *   1. The journal is READ-ONLY here. Evolution never writes to the raw
 *      layer.
 *   2. Redaction happens AT THE SAMPLER BOUNDARY: the journal stores
 *      unredacted tool output (unlike the memory index), so every text
 *      block passes redactSensitiveText(text, {mode: "tools"}) before it
 *      can reach any prompt or wiki page.
 *   3. Reconstruction yields to the event loop between runs and between
 *      event batches — gunzip+parse over hundreds of rows is exactly the
 *      kind of sync burst that trips the gateway watchdog (see
 *      src/memory/event-loop.ts).
 *
 * Formatting follows the paper (Appendix C): each formatted log is capped
 * (default 15,000 chars) before prompt injection; the middle is elided in
 * preference to the head (task setup) and tail (how it ended).
 */

import type { EventJournal, JournalEvent } from "../../infra/event-journal.js";
import type { ReconstructedTrace, TraceStep } from "./types.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { makeYieldEvery, yieldToEventLoop } from "../event-loop.js";

/** Paper Appendix C: per-log character cap before prompt injection. */
export const TRACE_LOG_MAX_CHARS = 15_000;

/** Cap on individual embedded blocks so one giant tool result cannot eat the log. */
const STEP_TEXT_MAX_CHARS = 4_000;

/** Total journal rows considered per run reconstruction. */
const RUN_EVENT_LIMIT = 10_000;

/**
 * Rows gunzipped per journal.query() call. query() decompresses its whole
 * result set SYNCHRONOUSLY, so the page size is the stall ceiling — the
 * live soak caught a 112s event-loop stall from a single 10k-row query
 * over a marathon session's giant tool outputs. Small pages + yields keep
 * each sync burst bounded.
 */
const RUN_EVENT_PAGE = 256;

/**
 * Runs with more events than this are marathon interactive sessions, not
 * learnable task executions — reconstructing them costs seconds of sync
 * gunzip for a trace the 15k-char formatter would elide to head+tail
 * anyway. The sampler skips them.
 */
export const MAX_RECONSTRUCT_EVENTS = 3_000;

/**
 * Page through one run's events with a yield between pages. Returns null
 * when the run exceeds maxEvents (marathon guard) and `enforceCap` is set.
 */
async function pageRunEvents(
  journal: EventJournal,
  runId: string,
  opts: { maxEvents: number; enforceCap: boolean },
): Promise<JournalEvent[] | null> {
  const events: JournalEvent[] = [];
  let sinceSeq = 0;
  for (;;) {
    const page = journal.query({ runId, sinceSeq, limit: RUN_EVENT_PAGE });
    if (page.length === 0) {
      break;
    }
    events.push(...page);
    sinceSeq = (page[page.length - 1] as JournalEvent).seq;
    if (events.length >= opts.maxEvents) {
      if (opts.enforceCap) {
        return null;
      }
      break;
    }
    await yieldToEventLoop();
  }
  return events;
}

function redact(text: string): string {
  return redactSensitiveText(text, { mode: "tools" });
}

function capText(text: string, max: number = STEP_TEXT_MAX_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

function asString(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (v === undefined || v === null) {
    return "";
  }
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/**
 * Reconstruct one run's trajectory from its journal events. Returns null when
 * the run has no events. Async purely for event-loop yielding.
 */
export async function reconstructTrace(
  journal: EventJournal,
  runId: string,
  opts: { skipMarathonRuns?: boolean } = {},
): Promise<ReconstructedTrace | null> {
  const events = await pageRunEvents(journal, runId, {
    maxEvents: opts.skipMarathonRuns ? MAX_RECONSTRUCT_EVENTS : RUN_EVENT_LIMIT,
    enforceCap: opts.skipMarathonRuns === true,
  });
  if (events === null || events.length === 0) {
    return null;
  }
  const tick = makeYieldEvery(64);

  const steps: TraceStep[] = [];
  let pendingAssistant: string | null = null;
  // Tool starts by toolCallId so results pair with their args even when
  // interleaved with assistant streaming.
  const pendingTools = new Map<string, { name: string; args: string }>();

  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let endedWithError = false;
  let errorText: string | null = null;
  let completedExplicitly = false;
  let sawTerminal = false;
  let toolCallCount = 0;
  let toolErrorCount = 0;

  const flushAssistant = () => {
    if (pendingAssistant && pendingAssistant.trim()) {
      steps.push({ kind: "assistant", text: capText(redact(pendingAssistant)) });
    }
    pendingAssistant = null;
  };

  for (const evt of events) {
    await tick();
    switch (evt.stream) {
      case "assistant": {
        // Assistant events carry cumulative text; keep the latest of each
        // streak and flush when a non-assistant event interrupts.
        const text = asString(evt.data.text);
        if (text) {
          pendingAssistant = text;
        }
        break;
      }
      case "tool": {
        flushAssistant();
        const phase = asString(evt.data.phase);
        const name = asString(evt.data.name) || "(unknown-tool)";
        const toolCallId = asString(evt.data.toolCallId);
        if (phase === "start") {
          toolCallCount += 1;
          pendingTools.set(toolCallId || `anon-${evt.seq}`, {
            name,
            args: capText(redact(asString(evt.data.args)), 1_500),
          });
        } else if (phase === "result") {
          const started = toolCallId ? pendingTools.get(toolCallId) : undefined;
          if (toolCallId) {
            pendingTools.delete(toolCallId);
          }
          const isError = evt.data.isError === true;
          if (isError) {
            toolErrorCount += 1;
          }
          steps.push({
            kind: "tool",
            name: started?.name ?? name,
            ...(toolCallId ? { toolCallId } : {}),
            args: started?.args ?? "",
            result: capText(redact(asString(evt.data.result))),
            isError,
          });
        }
        // phase === "update" partial results are skipped: the final result
        // supersedes them and they'd inflate the log with duplicates.
        break;
      }
      case "lifecycle": {
        const phase = asString(evt.data.phase);
        if (phase === "start") {
          startedAt = evt.ts;
        } else if (phase === "end") {
          flushAssistant();
          endedAt = evt.ts;
          sawTerminal = true;
          completedExplicitly = evt.data.completedExplicitly === true;
        } else if (phase === "error") {
          flushAssistant();
          endedAt = evt.ts;
          sawTerminal = true;
          endedWithError = true;
          errorText = capText(redact(asString(evt.data.error)), 1_000) || null;
        }
        break;
      }
      default:
        // thinking / compaction / custom streams are not part of the
        // trajectory view (reasoning is rarely journaled in production).
        break;
    }
  }
  flushAssistant();
  // Any tool call that never produced a result is itself a signal (the run
  // died mid-call); surface it as an errored step at the tail.
  for (const [toolCallId, started] of pendingTools) {
    steps.push({
      kind: "tool",
      name: started.name,
      toolCallId,
      args: started.args,
      result: "(no result recorded — run ended before the tool returned)",
      isError: true,
    });
    toolErrorCount += 1;
  }

  const last = events[events.length - 1] as JournalEvent;
  return {
    runId,
    taskId: last.taskId,
    sessionKey: last.sessionKey,
    startedAt,
    endedAt,
    steps,
    endedWithError,
    errorText,
    completedExplicitly,
    isComplete: sawTerminal,
    toolCallCount,
    toolErrorCount,
    lastSeq: last.seq,
  };
}

/**
 * Format a reconstructed trace into the prompt-ready log. Head and tail are
 * preserved under the cap; the middle is elided (task setup and terminal
 * behavior carry the most diagnostic weight).
 */
export function formatTraceLog(
  trace: ReconstructedTrace,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? TRACE_LOG_MAX_CHARS;
  const header = [
    `run: ${trace.runId}`,
    trace.taskId ? `task: ${trace.taskId}` : null,
    `outcome: ${trace.endedWithError ? `ERROR${trace.errorText ? ` (${trace.errorText})` : ""}` : trace.isComplete ? "ended" : "incomplete"}`,
    `tools: ${trace.toolCallCount} calls, ${trace.toolErrorCount} errors${trace.completedExplicitly ? "; agent called complete()" : ""}`,
    "",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const blocks = trace.steps.map((step) => {
    if (step.kind === "assistant") {
      return `[assistant]\n${step.text}`;
    }
    return `[tool ${step.name}${step.isError ? " ERROR" : ""}]\nargs: ${step.args}\nresult: ${step.result}`;
  });

  const full = `${header}${blocks.join("\n\n")}`;
  if (full.length <= maxChars) {
    return full;
  }
  // Keep the header, the first blocks, and the last blocks under budget.
  const budget = maxChars - header.length - 64;
  const headBudget = Math.floor(budget * 0.45);
  const tailBudget = budget - headBudget;
  const head: string[] = [];
  let headLen = 0;
  for (const b of blocks) {
    if (headLen + b.length > headBudget) {
      break;
    }
    head.push(b);
    headLen += b.length + 2;
  }
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as string;
    if (tailLen + b.length > tailBudget || head.length + tail.length >= blocks.length) {
      break;
    }
    tail.unshift(b);
    tailLen += b.length + 2;
  }
  const elided = blocks.length - head.length - tail.length;
  return `${header}${head.join("\n\n")}\n\n... [${elided} steps elided] ...\n\n${tail.join("\n\n")}`;
}

/**
 * List distinct run ids with events after `sinceSeq`, oldest-first, along
 * with each run's max seq. Yields between batches. Read-only.
 */
export async function listRunsSince(
  journal: EventJournal,
  opts: { sinceSeq: number; maxRuns?: number },
): Promise<Array<{ runId: string; lastSeq: number }>> {
  const maxRuns = opts.maxRuns ?? 40;
  const seen = new Map<string, number>();
  let cursor = opts.sinceSeq;
  const tick = makeYieldEvery(4);
  // Page through the journal without holding a long read inside one call.
  for (let page = 0; page < 200; page++) {
    await tick();
    const events = journal.query({ sinceSeq: cursor, limit: 500 });
    if (events.length === 0) {
      break;
    }
    for (const evt of events) {
      seen.set(evt.runId, evt.seq);
    }
    cursor = (events[events.length - 1] as JournalEvent).seq;
    if (seen.size >= maxRuns * 3) {
      // Enough candidates to satisfy maxRuns even after filtering.
      break;
    }
  }
  return Array.from(seen.entries())
    .map(([runId, lastSeq]) => ({ runId, lastSeq }))
    .toSorted((a, b) => a.lastSeq - b.lastSeq)
    .slice(0, maxRuns);
}
