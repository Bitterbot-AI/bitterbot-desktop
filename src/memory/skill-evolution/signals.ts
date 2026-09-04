/**
 * PLAN-44 Phase 1: programmatic trace signals.
 *
 * Before any LLM (labeler judge, wiki maintainer, corpus miner) reads a
 * trace, a pure function extracts what the journal can PROVE: the tool
 * sequence, repeated action loops, the class of every tool error, where the
 * first error happened and whether the agent recovered. The maintainer is
 * told to cite these rather than invent mechanisms (Honest Lying, arXiv
 * 2605.29463: free-text reflection on failures entrenched false beliefs;
 * programmatic signal extraction + evidence counting raised correct
 * diagnoses from 0% to 86%).
 *
 * Error classes split into ENVIRONMENT (provider outage, DNS, connection
 * refused, rate limit, 5xx, tool/service unavailable, run aborted) and
 * AGENT (policy block, exit non-zero, file not found, exception, edit
 * mismatch, 4xx). The labeler treats environment-only failures as
 * `env-fail`, which never reaches the wiki as an agent failure pattern.
 * Signatures come from the live journal (842 complete tool-bearing runs,
 * 136 tool errors, 2026-09-04 dump).
 */

import type { ReconstructedTrace, TraceToolStep } from "./types.js";

export type ErrorScope = "env" | "agent";

export interface ToolErrorClass {
  /** Short stable class id, e.g. "dns", "exit-nonzero". */
  cls: string;
  scope: ErrorScope;
}

export interface TraceSignals {
  toolSequence: string[];
  /** Consecutively repeated block (length 1-3) and how many times, if any. */
  repeated: { block: string[]; repeats: number } | null;
  /** One entry per errored tool step, in order. */
  errors: Array<{ index: number; tool: string; cls: string; scope: ErrorScope }>;
  agentErrorCount: number;
  envErrorCount: number;
  /** 0-based index (among tool steps) of the first error, or null. */
  firstErrorIndex: number | null;
  stepsAfterFirstError: number;
  /** A tool that errored later succeeded (same tool name). */
  recoveredAfterError: boolean;
}

/** Ordered: first match wins. Environment classes before agent classes. */
const ENV_RULES: Array<[string, RegExp]> = [
  ["provider", /LLM error|api_error|\bConnection error\.?|overloaded_error|model is overloaded/i],
  // Local services / config / tool bugs before the generic network classes:
  // "Can't reach ... (timed out)" is a service outage, not a timeout.
  [
    "service-unavailable",
    /Can't reach|cannot reach|not enabled\b|node required|invalid config|not configured|no api key|missing api key|is not a constructor|Cannot read properties of undefined/i,
  ],
  ["dns", /getaddrinfo|ENOTFOUND|EAI_AGAIN/i],
  ["rate-limit", /\b429\b|rate.?limit|too many requests|quota exceeded|insufficient credits/i],
  // HTTP 5xx before "connection": "Web fetch failed (503)" is a server error.
  [
    "server",
    /(?:status(?:Code)?|code|HTTP|failed)\D{0,6}\b5\d\d\b|Internal server error|service unavailable|bad gateway|gateway time-?out/i,
  ],
  // Bare "fetch failed" (Node's undici network error) is a connection
  // failure; "Web fetch failed (4xx)" is an HTTP status and stays agent-side.
  [
    "connection",
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|^\s*fetch failed\b|connection (?:refused|reset|closed)|network (?:is )?unreachable/i,
  ],
  [
    "timeout",
    /ETIMEDOUT|SSL connection timeout|Connection timed out|\(timed out\)|handshake timeout/i,
  ],
  ["aborted", /SIGTERM|SIGKILL|no result recorded|run ended before/i],
];

const AGENT_RULES: Array<[string, RegExp]> = [
  [
    "policy-block",
    /Security Violation|Blocked: resolves|INTERCEPTOR:|blocked by policy|not allowed/i,
  ],
  ["file-not-found", /ENOENT|no such file|not a git repository|does not exist/i],
  ["edit-mismatch", /Could not find the exact text|old_string not found/i],
  [
    "http-client",
    /(?:Web fetch failed|status(?:Code)?|HTTP)\D{0,6}\b4\d\d\b|\bNot Found\b|Cannot (?:GET|POST)/i,
  ],
  ["exit-nonzero", /exited with code [1-9]\d*|Command exited with code/i],
  ["exception", /Traceback|\bError:|throw err|Unhandled|TypeError|ReferenceError/i],
  ["timeout", /timed? ?out/i],
];

/**
 * Pull the human error string out of the tool-result envelope
 * ({"content":[{"type":"text","text":"{... \"error\": \"...\"}"}]}) when
 * present; otherwise use the raw text.
 */
export function extractErrorText(result: string): string {
  const raw = result ?? "";
  try {
    const outer = JSON.parse(raw) as { content?: Array<{ text?: string }>; error?: unknown };
    const inner = outer.content?.[0]?.text;
    if (typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner) as { error?: unknown };
        if (typeof parsed.error === "string") {
          return parsed.error;
        }
      } catch {
        return inner;
      }
      return inner;
    }
    if (typeof outer.error === "string") {
      return outer.error;
    }
  } catch {
    // not JSON
  }
  return raw;
}

export function classifyToolError(step: TraceToolStep): ToolErrorClass {
  const text = extractErrorText(step.result).slice(0, 2_000);
  for (const [cls, re] of ENV_RULES) {
    if (re.test(text)) {
      return { cls, scope: "env" };
    }
  }
  for (const [cls, re] of AGENT_RULES) {
    if (re.test(text)) {
      return { cls, scope: "agent" };
    }
  }
  return { cls: "error", scope: "agent" };
}

function findRepeatedBlock(seq: string[]): { block: string[]; repeats: number } | null {
  let best: { block: string[]; repeats: number } | null = null;
  for (let p = 1; p <= 3; p++) {
    for (let start = 0; start + p <= seq.length; start++) {
      const block = seq.slice(start, start + p);
      let repeats = 1;
      let pos = start + p;
      while (pos + p <= seq.length && block.every((t, i) => seq[pos + i] === t)) {
        repeats += 1;
        pos += p;
      }
      const threshold = p === 1 ? 3 : 2;
      if (repeats >= threshold && (!best || repeats * p > best.repeats * best.block.length)) {
        best = { block, repeats };
      }
    }
  }
  return best;
}

/** Pure. Safe on any trace shape (empty steps, no errors). */
export function extractTraceSignals(trace: ReconstructedTrace): TraceSignals {
  const tools = trace.steps.filter((s): s is TraceToolStep => s.kind === "tool");
  const toolSequence = tools.map((t) => t.name);
  const errors: TraceSignals["errors"] = [];
  tools.forEach((t, index) => {
    if (t.isError) {
      const c = classifyToolError(t);
      errors.push({ index, tool: t.name, cls: c.cls, scope: c.scope });
    }
  });
  const firstErrorIndex = errors.length > 0 ? errors[0]!.index : null;
  let recoveredAfterError = false;
  if (firstErrorIndex !== null) {
    const erroredTools = new Set(errors.map((e) => e.tool));
    for (let i = firstErrorIndex + 1; i < tools.length; i++) {
      const t = tools[i]!;
      if (!t.isError && erroredTools.has(t.name)) {
        recoveredAfterError = true;
        break;
      }
    }
  }
  return {
    toolSequence,
    repeated: findRepeatedBlock(toolSequence),
    errors,
    agentErrorCount: errors.filter((e) => e.scope === "agent").length,
    envErrorCount: errors.filter((e) => e.scope === "env").length,
    firstErrorIndex,
    stepsAfterFirstError: firstErrorIndex === null ? 0 : tools.length - firstErrorIndex - 1,
    recoveredAfterError,
  };
}

/** The `## Signals` block printed under the task header of every trace log. */
export function formatSignals(sig: TraceSignals): string {
  const seq = sig.toolSequence
    .map((name, i) => (sig.errors.some((e) => e.index === i) ? `${name}!` : name))
    .join(" > ");
  const lines = [
    "## Signals (computed from the journal, not by a model)",
    `tool-sequence: ${seq || "(none)"}`,
  ];
  if (sig.repeated) {
    lines.push(`repeated: ${sig.repeated.block.join(">")} x${sig.repeated.repeats}`);
  }
  if (sig.errors.length > 0) {
    lines.push(
      `error-classes: ${sig.errors.map((e) => `${e.tool}:${e.cls}${e.scope === "env" ? "(env)" : ""}`).join(", ")}`,
    );
    lines.push(
      `first-error-at: tool step ${(sig.firstErrorIndex ?? 0) + 1} of ${sig.toolSequence.length}; steps-after-first-error: ${sig.stepsAfterFirstError}; recovered: ${sig.recoveredAfterError ? "yes" : "no"}`,
    );
  } else {
    lines.push("error-classes: none");
  }
  return lines.join("\n");
}
