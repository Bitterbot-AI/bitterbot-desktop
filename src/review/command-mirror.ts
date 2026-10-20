/**
 * Shell-command approvals in the review queue (PLAN-53 B6).
 *
 * The exec tool asks for approval through its own manager and waits there;
 * that does not change. This mirrors each request into the review queue so a
 * command is answered in the same place as a spend or a message, shows up in
 * the Control UI (which had no way to answer one), and leaves the same record.
 * Answers given the old way, from chat or another client, are recorded too.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getReviewService } from "./runtime.js";
import type { CommandDecision } from "./service.js";

const log = createSubsystemLogger("review");

/** Approval id (the exec manager's) to review row id. Both are in-memory lived. */
const rows = new Map<string, string>();

export function mirrorCommandRequested(record: {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    agentId?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
}): void {
  try {
    const action = getReviewService().openCommand({
      approvalId: record.id,
      command: record.request.command,
      cwd: record.request.cwd,
      host: record.request.host,
      ctx: {
        sessionKey: record.request.sessionKey ?? undefined,
        agentId: record.request.agentId ?? undefined,
      },
      ttlMs: Math.max(1_000, record.expiresAtMs - record.createdAtMs),
    });
    rows.set(record.id, action.id);
  } catch (err) {
    // The approval itself still works through its own path.
    log.warn(`could not mirror command approval ${record.id}: ${String(err)}`);
  }
}

/** The approval ended: answered (by anyone, anywhere) or timed out (`null`). */
export function mirrorCommandSettled(
  approvalId: string,
  decision: CommandDecision | null,
  resolvedBy?: string | null,
): void {
  const reviewId = rows.get(approvalId);
  if (!reviewId) {
    return;
  }
  rows.delete(approvalId);
  try {
    getReviewService().settleCommand(reviewId, decision, {
      decidedBy: resolvedBy?.trim() || "operator",
      decidedVia: "exec-approval",
    });
  } catch (err) {
    log.warn(`could not record command approval ${approvalId}: ${String(err)}`);
  }
}

export function resetCommandMirrorForTest(): void {
  rows.clear();
}
