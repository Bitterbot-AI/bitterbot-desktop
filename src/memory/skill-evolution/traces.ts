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
import type { ReconstructedTrace, TraceStep, TraceTask } from "./types.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { makeYieldEvery, yieldToEventLoop } from "../event-loop.js";
import { classifyRunOrigin } from "./run-origin.js";

/** Paper Appendix C: per-log character cap before prompt injection. */
export const TRACE_LOG_MAX_CHARS = 15_000;

/** Cap on individual embedded blocks so one giant tool result cannot eat the log. */
const STEP_TEXT_MAX_CHARS = 4_000;

/** PLAN-44 Phase 0 (D-6): cap on the task text carried in the trace header. */
export const TASK_TEXT_MAX_CHARS = 4_000;

/** Total journal rows considered per run reconstruction. */
const RUN_EVENT_LIMIT = 10_000;

/**
 * Runs with more events than this are marathon interactive sessions, not
 * learnable task executions; the sampler and validator skip them (the
 * 15k-char formatter would elide them to head+tail anyway).
 */
export const MAX_RECONSTRUCT_EVENTS = 3_000;

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
 *
 * Inflation is SELECTIVE: a zero-cost queryMeta pass identifies exactly the
 * rows the trajectory needs — tool + lifecycle events plus the LAST
 * assistant event of each consecutive streak (assistant events carry
 * cumulative text, so earlier streak members are strictly redundant) — and
 * only those blobs are decompressed via getBySeqs. This is what keeps a
 * chatty run from inflating 100MB of cumulative text on the gateway's
 * event loop.
 */
export async function reconstructTrace(
  journal: EventJournal,
  runId: string,
  opts: { skipMarathonRuns?: boolean } = {},
): Promise<ReconstructedTrace | null> {
  const meta = journal.queryMeta({ runId, limit: RUN_EVENT_LIMIT });
  if (meta.length === 0) {
    return null;
  }
  if (opts.skipMarathonRuns && meta.length > MAX_RECONSTRUCT_EVENTS) {
    // Marathon interactive session: skip without inflating a single blob.
    return null;
  }
  // Select the seqs worth inflating.
  const wantedSeqs: number[] = [];
  let wantedUser = false;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i]!;
    if (m.stream === "assistant") {
      const next = meta[i + 1];
      if (!next || next.stream !== "assistant") {
        wantedSeqs.push(m.seq); // last of its streak
      }
    } else if (m.stream === "tool" || m.stream === "lifecycle") {
      wantedSeqs.push(m.seq);
    } else if (m.stream === "user" && !wantedUser) {
      // PLAN-44 Phase 0: the task header. One per run; the first wins.
      wantedSeqs.push(m.seq);
      wantedUser = true;
    }
  }
  await yieldToEventLoop();
  const events: JournalEvent[] = [];
  for (let i = 0; i < wantedSeqs.length; i += 200) {
    events.push(...journal.getBySeqs(wantedSeqs.slice(i, i + 200)));
    await yieldToEventLoop();
  }
  if (events.length === 0) {
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
  let task: TraceTask | null = null;
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
      case "user": {
        if (!task) {
          const text = asString(evt.data.text);
          const chars =
            typeof evt.data.chars === "number" && Number.isFinite(evt.data.chars)
              ? evt.data.chars
              : text.length;
          task = {
            text: capText(redact(text), TASK_TEXT_MAX_CHARS),
            chars,
            origin: classifyRunOrigin(evt.sessionKey ?? meta[meta.length - 1]?.sessionKey),
            isHeartbeat: evt.data.isHeartbeat === true,
            channel: asString(evt.data.channel) || null,
          };
        }
        break;
      }
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

  // Identity + cursor bookkeeping come from the run's TRUE last journal
  // event (meta view), not the last inflated one.
  const last = meta[meta.length - 1]!;
  return {
    runId,
    taskId: last.taskId,
    task,
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
  // PLAN-44 Phase 0: the task is the FIRST thing a reader sees. Runs
  // journaled before the `user` stream existed say so explicitly, so the
  // maintainer/judge never mistake "unknown task" for "no task".
  const taskLines = trace.task
    ? [
        `task-origin: ${trace.task.origin}${trace.task.channel ? ` via ${trace.task.channel}` : ""}${trace.task.isHeartbeat ? " (heartbeat)" : ""}`,
        `task: ${trace.task.text || "(empty prompt)"}`,
      ]
    : ["task: (not journaled — run predates the user stream)"];
  const header = [
    `run: ${trace.runId}`,
    trace.taskId ? `long-horizon-task: ${trace.taskId}` : null,
    ...taskLines,
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
 * Enumerate runs with events after `sinceSeq`, oldest-first, from METADATA
 * ONLY (zero blob inflation). Per-run counters let callers pre-filter
 * tool-less and marathon runs before any reconstruction; `maxRuns` counts
 * only TOOL-BEARING runs so heartbeat noise cannot starve the window.
 */
export interface RunSummary {
  runId: string;
  /** First seq seen for this run WITHIN the scan window (after sinceSeq). */
  firstSeq: number;
  /** Last seq seen for this run WITHIN the scan window (never past the horizon). */
  lastSeq: number;
  totalEvents: number;
  toolEvents: number;
  /**
   * Two or more lifecycle events (start + end/error) were seen in the
   * window. A single lifecycle event is a start with no terminal yet.
   */
  hasTerminal: boolean;
}

/**
 * PLAN-44 Phase 0: the scan's cursor-safety envelope. Audit finding: the
 * sampler advanced its cursor to a run's TRUE last seq (from an unbounded
 * per-run query) while the scan had stopped at a page horizon, so one run
 * that ended past the horizon dragged the cursor over every run in between
 * (98 interleaved runs in the live journal). Callers clamp to `horizonSeq`
 * and never advance past the first event of a run they did not examine.
 */
export interface RunScan {
  runs: RunSummary[];
  /** Last journal seq the scan actually looked at. */
  horizonSeq: number;
  /** Smallest firstSeq among runs seen but cut by `maxRuns` (null if none). */
  deferredMinFirstSeq: number | null;
}

export async function listRunsSinceDetailed(
  journal: EventJournal,
  opts: { sinceSeq: number; maxRuns?: number },
): Promise<RunScan> {
  const maxRuns = opts.maxRuns ?? 40;
  const seen = new Map<string, RunSummary & { lifecycleEvents: number }>();
  let cursor = opts.sinceSeq;
  const tick = makeYieldEvery(4);
  for (let page = 0; page < 400; page++) {
    await tick();
    const events = journal.queryMeta({ sinceSeq: cursor, limit: 1_000 });
    if (events.length === 0) {
      break;
    }
    for (const evt of events) {
      let summary = seen.get(evt.runId);
      if (!summary) {
        summary = {
          runId: evt.runId,
          firstSeq: evt.seq,
          lastSeq: evt.seq,
          totalEvents: 0,
          toolEvents: 0,
          hasTerminal: false,
          lifecycleEvents: 0,
        };
        seen.set(evt.runId, summary);
      }
      summary.lastSeq = evt.seq;
      summary.totalEvents += 1;
      if (evt.stream === "tool") {
        summary.toolEvents += 1;
      }
      if (evt.stream === "lifecycle") {
        summary.lifecycleEvents += 1;
        summary.hasTerminal = summary.lifecycleEvents >= 2;
      }
    }
    cursor = (events[events.length - 1] as { seq: number }).seq;
    const toolBearing = [...seen.values()].filter((r) => r.toolEvents > 0).length;
    if (toolBearing >= maxRuns * 2) {
      break;
    }
  }
  // Cap at maxRuns TOOL-BEARING runs; tool-less runs before the cutoff stay
  // included so callers can advance their cursor past the noise.
  const sorted = Array.from(seen.values()).toSorted((a, b) => a.lastSeq - b.lastSeq);
  const out: RunSummary[] = [];
  let deferredMinFirstSeq: number | null = null;
  let toolBearingKept = 0;
  let cut = false;
  for (const run of sorted) {
    const { lifecycleEvents: _ignored, ...summary } = run;
    if (cut) {
      deferredMinFirstSeq =
        deferredMinFirstSeq === null ? run.firstSeq : Math.min(deferredMinFirstSeq, run.firstSeq);
      continue;
    }
    if (run.toolEvents > 0) {
      if (toolBearingKept >= maxRuns) {
        cut = true;
        deferredMinFirstSeq = run.firstSeq;
        continue;
      }
      toolBearingKept += 1;
    }
    out.push(summary);
  }
  return { runs: out, horizonSeq: cursor, deferredMinFirstSeq };
}

/** Back-compat wrapper: the run list alone. Prefer listRunsSinceDetailed for cursor work. */
export async function listRunsSince(
  journal: EventJournal,
  opts: { sinceSeq: number; maxRuns?: number },
): Promise<RunSummary[]> {
  return (await listRunsSinceDetailed(journal, opts)).runs;
}
