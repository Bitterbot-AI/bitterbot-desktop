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
import {
  type Classification,
  classifyToolCall,
  type ContactRecipient,
  type ReviewClass,
} from "./classify.js";
import { contactKey, normalizeContact } from "./contacts.js";
import { holdGrantReservation } from "./grant-reservations.js";
import { REVIEW_DEFAULT_TTL_MS, type ReviewAction, type ReviewStore } from "./store.js";

const log = createSubsystemLogger("review");

export type ReviewPolicy = {
  spend: "ask" | "allow";
  publish: "ask" | "allow";
  /**
   * Messages to named recipients: "first" asks only for someone the agent has
   * never dealt with, "ask" for every one, "allow" for none.
   */
  contact: "first" | "ask" | "allow";
  ttlMs: number;
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  spend: "ask",
  publish: "ask",
  contact: "first",
  ttlMs: REVIEW_DEFAULT_TTL_MS,
};

export type ReviewContext = {
  sessionKey?: string;
  agentId?: string;
  runId?: string;
};

export type ReviewOutcome =
  | { kind: "pass"; reason: "unclassified" | "allowed" | "grant" | "approved" | "known" }
  | { kind: "hold"; action: ReviewAction; created: boolean };

/** The answers a shell-command approval takes. */
export type CommandDecision = "allow-once" | "allow-always" | "deny";

/**
 * Whether a standing permission covers the call. When it reserved something
 * to say yes (a grant's allowance), `release` gives that back if the call fails.
 */
export type StandingPermission = boolean | { release: () => void };

export type ExecutionResult = { ok: boolean; summary: string };

/** Runs an approved action with owner authority. One per gated tool. */
export type ApprovedExecutor = (action: ReviewAction) => Promise<ExecutionResult>;

export type ReviewServiceDeps = {
  store: ReviewStore;
  executors: Map<string, ApprovedExecutor>;
  /** A standing permission (a spend grant) that covers this call. */
  standingPermission?: (
    c: Classification,
    ctx: ReviewContext,
  ) => Promise<StandingPermission> | StandingPermission;
  /**
   * Recipients the agent already deals with, beyond the ones the owner has
   * approved here: people with a session, the owner, allow-listed senders.
   */
  knownContact?: (recipient: ContactRecipient, ctx: ReviewContext) => Promise<boolean> | boolean;
  /**
   * Fill in what a held call left to the run (the channel of a message), so
   * the stored call can be carried out later, outside that run.
   */
  completeParams?: (toolName: string, params: unknown, ctx: ReviewContext) => unknown;
  /**
   * Answer the shell-command approval a "command" row mirrors. False when the
   * exec tool is no longer waiting for it.
   */
  resolveCommand?: (action: ReviewAction, decision: CommandDecision, decidedBy: string) => boolean;
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
    if (classification.cls === "contact" && policy.contact === "first") {
      if (await this.knowsAll(classification.recipients ?? [], ctx)) {
        return { kind: "pass", reason: "known" };
      }
    }
    const standing = this.deps.standingPermission
      ? await this.deps.standingPermission(classification, ctx)
      : false;
    if (standing) {
      if (typeof standing === "object") {
        holdGrantReservation(ctx.sessionKey, fingerprint, standing.release);
      }
      return { kind: "pass", reason: "grant" };
    }
    const { action, created } = this.deps.store.request({
      id: this.newId(),
      cls: classification.cls,
      tool: toolName,
      params: this.deps.completeParams?.(toolName, params, ctx) ?? params,
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
    by: { decidedBy: string; decidedVia: string; note?: string; always?: boolean },
  ): Promise<ReviewAction | null> {
    const status = decision === "approve" ? "approved" : "denied";
    const before = this.deps.store.get(id);
    if (before?.cls === "command") {
      if (before.status !== "pending") {
        return null;
      }
      // The exec tool holds the real approval; answer that, then record it.
      const answer: CommandDecision =
        decision === "deny" ? "deny" : by.always ? "allow-always" : "allow-once";
      if (!this.deps.resolveCommand?.(before, answer, by.decidedBy)) {
        this.deps.store.expire(id);
        this.announce(id);
        return null;
      }
      return this.settleCommand(id, answer, by);
    }
    if (!this.deps.store.decide(id, status, by)) {
      return null;
    }
    let action = this.deps.store.get(id);
    if (!action) {
      return null;
    }
    if (action.cls === "handoff") {
      // Nothing to execute: the agent's own tool call is waiting on this row
      // (see handoff.ts) and reads the decision from it.
      log.info(`${id} handoff ${status} by ${by.decidedBy}`);
      this.deps.broadcast?.("review.resolved", publicView(action));
      return action;
    }
    if (decision === "approve") {
      const outcome = await this.execute(action);
      this.deps.store.markExecution(id, outcome);
      if (outcome.ok && action.cls === "contact") {
        // Approved and delivered: this recipient is no longer a first contact.
        for (const recipient of classifyToolCall(action.tool, action.params)?.recipients ?? []) {
          this.deps.store.rememberContact(
            { key: contactKey(recipient), address: normalizeContact(recipient.target) },
            id,
          );
        }
      }
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

  private async knowsAll(recipients: ContactRecipient[], ctx: ReviewContext): Promise<boolean> {
    if (recipients.length === 0) {
      return false;
    }
    for (const recipient of recipients) {
      // An approval is for a channel. A call that leaves the channel to the
      // run is covered by an approval on any of them.
      const remembered = recipient.channel
        ? this.deps.store.hasContact(contactKey(recipient))
        : this.deps.store.hasContactAddress(normalizeContact(recipient.target));
      if (remembered) {
        continue;
      }
      if (!(this.deps.knownContact && (await this.deps.knownContact(recipient, ctx)))) {
        return false;
      }
    }
    return true;
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

  /** A shell command is waiting for approval: put it in the queue. */
  openCommand(input: {
    approvalId: string;
    command: string;
    cwd?: string | null;
    host?: string | null;
    ctx: ReviewContext;
    ttlMs: number;
  }): ReviewAction {
    const params = {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.host ? { host: input.host } : {}),
      approvalId: input.approvalId,
    };
    const { action, created } = this.deps.store.request({
      id: this.newId(),
      cls: "command",
      tool: "exec",
      params,
      // One row per approval, not per command text: the same command asked
      // twice is two questions.
      fingerprint: `command:${input.approvalId}`,
      preview: `Run: ${input.command.slice(0, 300)}${input.cwd ? ` (in ${input.cwd})` : ""}`,
      sessionKey: input.ctx.sessionKey ?? null,
      agentId: input.ctx.agentId ?? null,
      runId: input.ctx.runId ?? null,
      ttlMs: input.ttlMs,
    });
    if (created) {
      this.deps.broadcast?.("review.requested", publicView(action));
    }
    return action;
  }

  /**
   * Record how a shell-command approval ended, whichever surface answered it.
   * `null` means nobody did. Safe to call twice.
   */
  settleCommand(
    id: string,
    decision: CommandDecision | null,
    by: { decidedBy: string; decidedVia: string },
  ): ReviewAction | null {
    if (decision === null) {
      this.expireHandoff(id);
      return this.deps.store.get(id);
    }
    const changed = this.deps.store.decide(id, decision === "deny" ? "denied" : "approved", by);
    if (changed) {
      if (decision !== "deny") {
        this.deps.store.markExecution(id, {
          ok: true,
          summary:
            decision === "allow-always"
              ? "Allowed, and added to the allowlist for next time."
              : "Allowed once.",
        });
      }
      log.info(`${id} command ${decision} by ${by.decidedBy}`);
      this.announce(id);
    }
    return this.deps.store.get(id);
  }

  /**
   * The agent asks the owner to take over the browser. Not an approval of a
   * tool call: the row is how the request reaches the owner and how the
   * handoff shows up in the activity record.
   */
  openHandoff(input: {
    reason: string;
    profile: string;
    url?: string;
    ctx: ReviewContext;
    ttlMs: number;
  }): { action: ReviewAction; created: boolean } {
    // The page address travels with the request so the card can say where the
    // person is being sent: the reason is the agent's wording, the address is not.
    const params = {
      action: "handoff",
      reason: input.reason,
      profile: input.profile,
      ...(input.url ? { url: input.url } : {}),
    };
    const where = input.url ? ` (${input.url.slice(0, 120)})` : "";
    const requested = this.deps.store.request({
      id: this.newId(),
      cls: "handoff",
      tool: "browser",
      params,
      fingerprint: toolCallFingerprint("browser", params),
      preview: `Take over the browser: ${input.reason.slice(0, 200)}${where}`,
      sessionKey: input.ctx.sessionKey ?? null,
      agentId: input.ctx.agentId ?? null,
      runId: input.ctx.runId ?? null,
      ttlMs: input.ttlMs,
    });
    if (requested.created) {
      log.info(`handoff requested ${requested.action.id}: ${requested.action.preview}`);
      this.deps.broadcast?.("review.requested", publicView(requested.action));
    }
    return requested;
  }

  /** The owner took the browser. False if the row was already decided. */
  acceptHandoff(id: string, by: { decidedBy: string; decidedVia: string }): boolean {
    const changed = this.deps.store.decide(id, "approved", by);
    if (changed) {
      this.announce(id);
    }
    return changed;
  }

  /** The handoff is over, one way or the other. */
  finishHandoff(id: string, outcome: ExecutionResult): void {
    this.deps.store.markExecution(id, outcome);
    this.announce(id);
  }

  /** Nobody answered the handoff request in time. */
  expireHandoff(id: string): void {
    if (this.deps.store.expire(id)) {
      this.announce(id);
    }
  }

  private announce(id: string): void {
    const action = this.deps.store.get(id);
    if (action) {
      this.deps.broadcast?.("review.resolved", publicView(action));
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
