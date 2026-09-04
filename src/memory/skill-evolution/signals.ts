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

/** Ordered: first match wins. Environment classes before agent classes (generic tools). */
const ENV_RULES: Array<[string, RegExp]> = [
  ["provider", /LLM error|api_error|\bConnection error\.?|overloaded_error|model is overloaded/i],
  // HTTP 5xx before "connection": "Web fetch failed (503)" is a server error.
  [
    "server",
    /(?:status(?:Code)?|code|HTTP|failed)\D{0,6}\b5\d\d\b|Internal server error|service unavailable|bad gateway|gateway time-?out/i,
  ],
  // Local services / config / tool bugs before the generic network classes:
  // "Can't reach ... (timed out)" is a service outage, not a timeout.
  [
    "service-unavailable",
    /Can't reach|cannot reach|not enabled\b|node required|invalid config|not configured|no api key|missing api key|missing_\w*api_key|\bunavailable\b|not available|not initialized|did not start within|is not a constructor|Cannot read properties of undefined/i,
  ],
  ["dns", /getaddrinfo|ENOTFOUND|EAI_AGAIN|Could not resolve host/i],
  [
    "rate-limit",
    /HTTP 429|status(?:Code)?\D{0,4}429|\(429\)|429 Too Many|Too Many Requests|rate limit exceeded|rate-limited|quota exceeded|insufficient credits/i,
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
    /Security Violation|Blocked: resolves|INTERCEPTOR:|blocked by policy|not allowed|are disabled\b/i,
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

/** Network errors a shell command can surface; env unless the target is loopback. */
const SHELL_NETWORK_RE =
  /curl: \((?:6|7|28|35|52|56)\)|Could not resolve host|Connection refused|Connection reset|SSL connection timeout|Connection timed out|Network is unreachable|getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i;
const LOOPBACK_RE = /\blocalhost\b|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1\b/;

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

/** Head + tail so the harness reason line at the end of long output survives (adversarial M-1). */
function headTail(text: string, head = 1_500, tail = 500): string {
  return text.length > head + tail ? `${text.slice(0, head)}\n${text.slice(-tail)}` : text;
}

function matchRules(rules: Array<[string, RegExp]>, text: string): string | null {
  for (const [cls, re] of rules) {
    if (re.test(text)) {
      return cls;
    }
  }
  return null;
}

/**
 * Shell commands (adversarial H-1): the agent chose the command, so the
 * error is agent-side by default. The harness appends its reason as the
 * final paragraph ("Command exited with code N", "Command timed out",
 * "Command aborted by signal"); the command's own output precedes it and
 * must never be scanned with the environment rules (a script's own
 * TypeError or a test summary containing "429" is not an outage). The one
 * environment class a shell command can prove is a NETWORK failure toward
 * a REMOTE host; the same failure toward loopback is the agent's own
 * unstarted service.
 */
function classifyShell(full: string): ToolErrorClass {
  const paragraphs = full.trim().split(/\n\s*\n/);
  const reason = paragraphs.at(-1) ?? full;
  const output = paragraphs.length > 1 ? paragraphs.slice(0, -1).join("\n") : "";
  if (/no result recorded|run ended before/i.test(reason)) {
    return { cls: "aborted", scope: "env" };
  }
  if (/Security Violation|blocked by policy|not allowed/i.test(reason)) {
    return { cls: "policy-block", scope: "agent" };
  }
  if (/aborted by signal|SIGTERM|SIGKILL/i.test(reason)) {
    return { cls: "aborted", scope: "env" };
  }
  if (/Command timed out|timed? ?out after/i.test(reason)) {
    return { cls: "timeout", scope: "agent" };
  }
  const probe = headTail(output || reason);
  if (SHELL_NETWORK_RE.test(probe)) {
    return LOOPBACK_RE.test(probe)
      ? { cls: "local-service", scope: "agent" }
      : { cls: "network", scope: "env" };
  }
  if (LOOPBACK_RE.test(probe) && /HTTP\/\d|\b5\d\d\b|refused|ECONNREFUSED/i.test(probe)) {
    // The agent's own server answered badly (or not at all).
    return { cls: "local-service", scope: "agent" };
  }
  const fine = matchRules(
    AGENT_RULES.filter(([cls]) => cls !== "exit-nonzero" && cls !== "timeout"),
    probe,
  );
  if (fine) {
    return { cls: fine, scope: "agent" };
  }
  if (/exited with code/i.test(reason)) {
    return { cls: "exit-nonzero", scope: "agent" };
  }
  return { cls: matchRules(AGENT_RULES, reason) ?? "error", scope: "agent" };
}

/**
 * web_fetch (adversarial M-5): the response body rides inside the error
 * string, so a page can contain any signature it likes. Classify on the
 * HTTP status when present and on the FIRST LINE otherwise; never on the
 * body.
 */
function classifyWebFetch(full: string): ToolErrorClass {
  const status = full.match(/Web fetch failed \((\d{3})\)/)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 429) {
      return { cls: "rate-limit", scope: "env" };
    }
    if (code >= 500) {
      return { cls: "server", scope: "env" };
    }
    return { cls: "http-client", scope: "agent" };
  }
  const firstLine = full.split("\n")[0] ?? full;
  if (/Blocked: resolves|not allowed/i.test(firstLine)) {
    return { cls: "policy-block", scope: "agent" };
  }
  const env = matchRules(ENV_RULES, firstLine);
  if (env) {
    return { cls: env, scope: "env" };
  }
  return { cls: matchRules(AGENT_RULES, firstLine) ?? "error", scope: "agent" };
}

export function classifyToolError(step: TraceToolStep): ToolErrorClass {
  const full = extractErrorText(step.result);
  if (step.name === "exec" || step.name === "process") {
    return classifyShell(full);
  }
  if (step.name === "web_fetch") {
    return classifyWebFetch(full);
  }
  const text = headTail(full);
  const env = matchRules(ENV_RULES, text);
  if (env) {
    return { cls: env, scope: "env" };
  }
  return { cls: matchRules(AGENT_RULES, text) ?? "error", scope: "agent" };
}

/**
 * PLAN-44 (adversarial H-4): a lifecycle error is the LLM call failing —
 * a provider outage in every live instance — unless its text names
 * something the agent did (context overflow from over-reading, calling a
 * tool that does not exist in this sandbox).
 */
export function classifyLifecycleError(errorText: string | null): ToolErrorClass {
  const text = errorText ?? "";
  if (
    /context overflow|prompt (?:is )?too (?:large|long)|request_too_large|too many tokens/i.test(
      text,
    )
  ) {
    return { cls: "context-overflow", scope: "agent" };
  }
  if (/unknown tool|not available in this sandbox|no such tool/i.test(text)) {
    return { cls: "unknown-tool", scope: "agent" };
  }
  return { cls: "provider", scope: "env" };
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
    // A tool that errored EARLIER and succeeded LATER (adversarial L-4:
    // a success before the tool's own error is not a recovery).
    const erroredSoFar = new Set<string>();
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i]!;
      if (t.isError) {
        erroredSoFar.add(t.name);
      } else if (erroredSoFar.has(t.name)) {
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
