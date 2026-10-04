/**
 * Action review (PLAN-53 Track B): hold an action that needs the owner's
 * decision, record the decision, run the action on the gateway when approved.
 *
 * Why the gateway runs the approved action itself instead of waking the agent
 * to call the tool again: a woken turn is a heartbeat or system turn, not an
 * owner turn, so it would not have the wallet tool at all (owner-only since
 * #140), and it may run in another session on another model. The person
 * approved exactly this call; the gateway performs exactly this call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { toolCallFingerprint } from "../agents/agent-tools.repeat-guard.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type Classification, classifyToolCall, type ReviewClass } from "./classify.js";
import { REVIEW_DEFAULT_TTL_MS, type ReviewAction, type ReviewStore } from "./store.js";

const log = createSubsystemLogger("review");

export type ReviewPolicy = {
  spend: "ask" | "allow";
  publish: "ask" | "allow";
  ttlMs: number;
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  spend: "ask",
  publish: "ask",
  ttlMs: REVIEW_DEFAULT_TTL_MS,
};

export type ReviewContext = {
  sessionKey?: string;
  agentId?: string;
  runId?: string;
};

export type ReviewOutcome =
  | { kind: "pass"; reason: "unclassified" | "allowed" | "grant" | "approved" }
  | { kind: "hold"; action: ReviewAction; created: boolean };

export type ExecutionResult = { ok: boolean; summary: string };

/** Runs an approved action with owner authority. One per gated tool. */
export type ApprovedExecutor = (action: ReviewAction) => Promise<ExecutionResult>;

export type ReviewServiceDeps = {
  store: ReviewStore;
  executors: Map<string, ApprovedExecutor>;
  /** A standing permission (a spend grant) that covers this call. */
  standingPermission?: (c: Classification, ctx: ReviewContext) => Promise<boolean> | boolean;
  /** Tell every listening Control UI window. */
  broadcast?: (event: "review.requested" | "review.resolved", payload: unknown) => void;
  /** Put a line in front of a session's next turn. */
  notifySession?: (sessionKey: string, text: string, contextKey: string) => void;
  now?: () => number;
  newId?: () => string;
};

const approvedExecution = new AsyncLocalStorage<{ fingerprint: string }>();

/** The hook stage lets an approved call through only inside this scope. */
export function runAsApproved<T>(fingerprint: string, fn: () => Promise<T>): Promise<T> {
  return approvedExecution.run({ fingerprint }, fn);
}

const defaultId = () => `rv-${crypto.randomBytes(4).toString("hex")}`;

/** The message the agent reads instead of the tool's result. */
export function holdMessage(action: ReviewAction, created: boolean): string {
  const head = created
    ? `APPROVAL-REQUIRED (${action.id}): ${action.preview}`
    : `APPROVAL-PENDING (${action.id}): ${action.preview}`;
  return [
    head,
    "",
    "This action was not performed. The owner has been asked to approve it and",
    "the gateway will carry it out for them if they do; you will be told the",
    "result. Do NOT retry it and do NOT look for another way to do the same",
    "thing. Tell the user it is waiting for their approval.",
  ].join("\n");
}

export class ReviewService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ReviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? defaultId;
  }

  /** Decide whether a tool call may proceed now. */
  async consider(
    toolName: string,
    params: unknown,
    ctx: ReviewContext,
    policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
  ): Promise<ReviewOutcome> {
    const classification = classifyToolCall(toolName, params);
    if (!classification) {
      return { kind: "pass", reason: "unclassified" };
    }
    if (policy[classification.cls] === "allow") {
      return { kind: "pass", reason: "allowed" };
    }
    const fingerprint = toolCallFingerprint(toolName, params);
    const approved = approvedExecution.getStore();
    if (approved && approved.fingerprint === fingerprint) {
      return { kind: "pass", reason: "approved" };
    }
    if (this.deps.standingPermission && (await this.deps.standingPermission(classification, ctx))) {
      return { kind: "pass", reason: "grant" };
    }
    const { action, created } = this.deps.store.request({
      id: this.newId(),
      cls: classification.cls,
      tool: toolName,
      params,
      fingerprint,
      preview: classification.preview,
      sessionKey: ctx.sessionKey ?? null,
      agentId: ctx.agentId ?? null,
      runId: ctx.runId ?? null,
      ttlMs: policy.ttlMs,
    });
    if (created) {
      log.info(`held for approval ${action.id}: ${action.cls} ${action.preview}`);
      this.deps.broadcast?.("review.requested", publicView(action));
      if (action.sessionKey) {
        this.deps.notifySession?.(
          action.sessionKey,
          `[review] Approval needed (${action.id}): ${action.preview}. ` +
            `Approve or deny it in the Control UI, or reply "/approve ${action.id} allow" or "/approve ${action.id} deny".`,
          `review:${action.id}`,
        );
      }
    }
    return { kind: "hold", action, created };
  }

  /**
   * Record a decision and, when approved, carry the action out. Returns the
   * row as it is afterwards, or null if the id is unknown or already decided.
   */
  async resolve(
    id: string,
    decision: "approve" | "deny",
    by: { decidedBy: string; decidedVia: string; note?: string },
  ): Promise<ReviewAction | null> {
    const status = decision === "approve" ? "approved" : "denied";
    if (!this.deps.store.decide(id, status, by)) {
      return null;
    }
    let action = this.deps.store.get(id);
    if (!action) {
      return null;
    }
    if (decision === "approve") {
      const outcome = await this.execute(action);
      this.deps.store.markExecution(id, outcome);
      action = this.deps.store.get(id) ?? action;
      log.info(
        `${id} approved by ${by.decidedBy}: ${outcome.ok ? "done" : "FAILED"} ${outcome.summary.slice(0, 120)}`,
      );
    } else {
      log.info(`${id} denied by ${by.decidedBy}`);
    }
    this.deps.broadcast?.("review.resolved", publicView(action));
    if (action.sessionKey) {
      this.deps.notifySession?.(action.sessionKey, sessionOutcomeText(action), `review:${id}`);
    }
    return action;
  }

  private async execute(action: ReviewAction): Promise<ExecutionResult> {
    const executor = this.deps.executors.get(action.tool);
    if (!executor) {
      return { ok: false, summary: `no executor is registered for the ${action.tool} tool` };
    }
    try {
      return await runAsApproved(action.fingerprint, () => executor(action));
    } catch (err) {
      return { ok: false, summary: err instanceof Error ? err.message : String(err) };
    }
  }

  list(opts?: Parameters<ReviewStore["list"]>[0]): ReviewAction[] {
    return this.deps.store.list(opts);
  }

  get(id: string): ReviewAction | null {
    return this.deps.store.get(id);
  }

  pendingCount(): number {
    return this.deps.store.pendingCount();
  }
}

/** The row without the raw parameters' internals mattering to the wire. */
export function publicView(action: ReviewAction) {
  return {
    id: action.id,
    status: action.status,
    cls: action.cls,
    tool: action.tool,
    preview: action.preview,
    params: action.params,
    sessionKey: action.sessionKey,
    agentId: action.agentId,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    decidedAt: action.decidedAt,
    decidedBy: action.decidedBy,
    decidedVia: action.decidedVia,
    note: action.note,
    resultSummary: action.resultSummary,
    executedAt: action.executedAt,
  };
}

export type ReviewActionView = ReturnType<typeof publicView>;

function sessionOutcomeText(action: ReviewAction): string {
  switch (action.status) {
    case "executed":
      return `[review] Approved and done (${action.id}): ${action.preview}. Result: ${action.resultSummary ?? "ok"}`;
    case "failed":
      return `[review] Approved, but it failed (${action.id}): ${action.preview}. Error: ${action.resultSummary ?? "unknown"}`;
    case "denied":
      return `[review] Denied (${action.id}): ${action.preview}. Do not retry it.`;
    default:
      return `[review] ${action.id} is now ${action.status}: ${action.preview}`;
  }
}

export { type Classification, type ReviewClass };
