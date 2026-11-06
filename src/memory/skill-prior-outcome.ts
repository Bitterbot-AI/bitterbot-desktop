import type { SkillReadProof } from "../agents/skills/skill-read-provenance.js";
import { isSkillReadPath } from "../agents/skills/skill-read-provenance.js";
import type { JournalEvent } from "../infra/event-journal.js";
import { isValidRunId, type RunFeedbackEntry } from "./skill-evolution/run-feedback.js";
import { classifyRunOrigin } from "./skill-evolution/run-origin.js";

export interface SkillPriorCredit {
  runId: string;
  skill: { name: string; hash: string };
  outcome: 0 | 1;
  startedAt: number;
  source: "task-checks" | "owner-feedback";
  revision: string;
  signalOrder: number;
  author: "model" | "operator" | "unknown";
}

export interface SkillPriorExecution {
  run_id: string;
  tool_call_id: string | null;
  recorded_by: string | null;
  completed_at: number | null;
  success: number | null;
  context_json: string | null;
}

export type SkillPriorSelection =
  | { credit: SkillPriorCredit; reason: "verified" }
  | { credit?: undefined; reason: string };

export function isLivePriorSession(sessionKey: string): boolean {
  // Explicit benchmark/harness namespaces never share live evidence.
  if (/(?:^|[:/_-])(?:bench(?:mark)?s?|harness|eval|test)(?:$|[:/_-])/i.test(sessionKey))
    return false;
  const origin = classifyRunOrigin(sessionKey);
  return origin === "human" || origin === "system";
}

// JSON read from disk may not honor the interface's boolean types.
function isExplicitTrue(value: unknown): value is true {
  return value === true;
}

/** Pure, fail-closed attribution. No reads of today's SKILL.md or inferred outcomes. */
export function selectSkillPriorOutcome(params: {
  runId: string;
  events: JournalEvent[];
  taskEvents: JournalEvent[];
  executions: SkillPriorExecution[];
  feedback?: RunFeedbackEntry;
  completeHistory: boolean;
}): SkillPriorSelection {
  const skip = (reason: string): SkillPriorSelection => ({ reason });
  if (!params.completeHistory || !isValidRunId(params.runId)) return skip("incomplete-history");
  const events = params.events;
  const start =
    events.find((e) => e.stream === "user") ??
    events.find((e) => e.stream === "lifecycle" && e.data.phase === "start");
  const end = events.findLast(
    (e) => e.stream === "lifecycle" && (e.data.phase === "end" || e.data.phase === "error"),
  );
  if (!start || !end || end.seq <= start.seq) return skip("unfinished");
  if (
    events.some(
      (e) =>
        e.seq > end.seq &&
        (e.stream === "tool" || (e.stream === "lifecycle" && e.data.phase === "start")),
    )
  )
    return skip("unfinished");
  const sessionKey = start.sessionKey;
  if (
    !sessionKey ||
    !isLivePriorSession(sessionKey) ||
    !isLivePriorSession(
      params.runId.startsWith("agent:") ? params.runId : "agent:main:" + params.runId,
    )
  )
    return skip("excluded-origin");
  const starts = events.filter((e) => {
    if (e.stream !== "tool" || e.data.phase !== "start" || e.data.name !== "read") return false;
    const args = e.data.args as Record<string, unknown> | undefined;
    return isSkillReadPath(args?.path ?? args?.file_path ?? args?.filePath);
  });
  const readIds = new Set(starts.map((e) => e.data.toolCallId));
  for (const event of events) {
    if (event.stream !== "tool" || event.data.phase !== "result" || event.data.name !== "read")
      continue;
    const result = event.data.result as
      | { details?: { skillReadPath?: string; skillRead?: SkillReadProof } }
      | undefined;
    if (isSkillReadPath(result?.details?.skillReadPath ?? result?.details?.skillRead?.path))
      readIds.add(event.data.toolCallId);
  }
  if (readIds.size !== 1) return skip(readIds.size ? "multiple-skill-reads" : "no-skill-read");
  const readId = [...readIds][0];
  const read = events.find(
    (e) => e.stream === "tool" && e.data.phase === "start" && e.data.toolCallId === readId,
  );
  if (!read || typeof readId !== "string" || read.seq <= start.seq) return skip("incomplete-read");
  const results = events.filter(
    (e) =>
      e.stream === "tool" &&
      e.data.phase === "result" &&
      e.data.toolCallId === read.data.toolCallId,
  );
  if (
    results.length !== 1 ||
    results[0].data.isError === true ||
    results[0].seq > end.seq ||
    results[0].seq <= read.seq
  )
    return skip("incomplete-read");
  if (params.executions.length !== 1) return skip("ambiguous-execution");
  const execution = params.executions[0];
  if (
    execution.run_id !== params.runId ||
    execution.tool_call_id !== read.data.toolCallId ||
    execution.recorded_by !== "after_tool_call" ||
    execution.completed_at === null ||
    execution.success !== 1
  )
    return skip("untracked-read");
  let proof: SkillReadProof | undefined;
  try {
    proof = (JSON.parse(execution.context_json ?? "{}") as { skillRead?: SkillReadProof })
      .skillRead;
  } catch {
    return skip("missing-read-proof");
  }
  if (
    !proof ||
    proof.version !== 1 ||
    !isExplicitTrue(proof.complete) ||
    !/^[a-f0-9]{64}$/.test(proof.hash) ||
    typeof proof.name !== "string" ||
    !proof.name ||
    proof.name.length > 256 ||
    /[|\r\n]/.test(proof.name) ||
    ["__proto__", "constructor", "prototype"].includes(proof.name)
  )
    return skip("missing-read-proof");
  const context = proof.context;
  if (
    !context ||
    context.runId !== params.runId ||
    context.sessionKey !== sessionKey ||
    !isExplicitTrue(context.senderIsOwner)
  )
    return skip("non-owner");
  if (end.data.phase === "error") return skip("environment-or-unknown-failure");
  const base = {
    runId: params.runId,
    skill: { name: proof.name, hash: proof.hash },
    startedAt: start.ts,
  };
  const feedback = params.feedback;
  if (
    feedback?.authority === "owner-operator" &&
    feedback.eventId &&
    feedback.runId === params.runId &&
    Number.isFinite(feedback.ts) &&
    feedback.ts >= start.ts &&
    (feedback.verdict === "confirmed" || feedback.verdict === "rejected")
  ) {
    return {
      reason: "verified",
      credit: {
        ...base,
        outcome: feedback.verdict === "confirmed" ? 1 : 0,
        source: "owner-feedback",
        revision: feedback.eventId,
        signalOrder: feedback.sequence ?? 0,
        author: "operator",
      },
    };
  }
  const task = context.task;
  if (
    !task ||
    task.id !== read.taskId ||
    !Number.isSafeInteger(task.revision) ||
    task.revision < 0 ||
    !Number.isSafeInteger(task.updatedAt) ||
    task.updatedAt < 0 ||
    typeof task.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(task.hash) ||
    !["model", "operator", "unknown"].includes(task.author)
  )
    return skip("no-frozen-checks");
  const judged = params.taskEvents.findLast(
    (e) =>
      e.taskId === task.id &&
      e.stream === "task" &&
      e.data.phase === "judged" &&
      e.data.runId === params.runId,
  );
  if (!judged || judged.seq <= read.seq) return skip("no-bound-verdict");
  const d = judged.data;
  if (
    task.updatedAt >= start.ts ||
    d.checksHash !== task.hash ||
    d.checksRevision !== task.revision ||
    d.checksStable !== true ||
    d.checksAuthor !== task.author ||
    params.taskEvents.some(
      (e) =>
        e.taskId === task.id &&
        e.data.phase === "checks_changed" &&
        e.seq >= start.seq &&
        e.seq <= Math.max(end.seq, judged.seq),
    )
  )
    return skip("checks-changed");
  const total = d.checksTotal,
    passed = d.checksPassed,
    failed = d.checksFailedExecuted;
  if (
    !Number.isSafeInteger(total) ||
    (total as number) <= 0 ||
    (total as number) > 20 ||
    !Number.isSafeInteger(passed) ||
    !Number.isSafeInteger(failed) ||
    (passed as number) < 0 ||
    (failed as number) < 0 ||
    (passed as number) + (failed as number) !== total ||
    d.checksExecuted !== total ||
    d.checksIndependent !== true
  )
    return skip("checks-not-independent-or-unexecuted");
  let outcome: 0 | 1;
  if (d.verdict === "pass" && passed === total && failed === 0) outcome = 1;
  else if (d.verdict === "fail" && (failed as number) > 0) outcome = 0;
  else return skip("judge-only-or-unknown");
  return {
    reason: "verified",
    credit: {
      ...base,
      outcome,
      source: "task-checks",
      revision: "task:" + judged.seq,
      signalOrder: judged.seq,
      author: task.author,
    },
  };
}
