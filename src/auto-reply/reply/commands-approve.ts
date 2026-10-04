import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/approve";

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

export function isReviewId(id: string): boolean {
  return /^rv-[0-9a-f]{8}$/i.test(id.trim());
}

export function describeReviewOutcome(
  id: string,
  outcome: { status?: string; preview?: string; resultSummary?: string | null } | null,
): string {
  const what = outcome?.preview ? ` ${outcome.preview}` : "";
  switch (outcome?.status) {
    case "executed":
      return `✅ Approved and done (${id}):${what}${outcome?.resultSummary ? `\n${outcome.resultSummary}` : ""}`;
    case "failed":
      return `⚠️ Approved, but it failed (${id}):${what}${outcome?.resultSummary ? `\n${outcome.resultSummary}` : ""}`;
    case "denied":
      return `🚫 Denied (${id}):${what}`;
    default:
      return `Decision recorded for ${id}${outcome?.status ? ` (${outcome.status})` : ""}.`;
  }
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  if (isInternalMessageChannel(params.command.channel)) {
    const scopes = params.ctx.GatewayClientScopes ?? [];
    const hasApprovals = scopes.includes("operator.approvals") || scopes.includes("operator.admin");
    if (!hasApprovals) {
      logVerbose("Ignoring /approve from gateway client missing operator.approvals.");
      return {
        shouldContinue: false,
        reply: {
          text: "❌ /approve requires operator.approvals for gateway clients.",
        },
      };
    }
  }

  const resolvedBy = buildResolvedByLabel(params);

  // PLAN-53 Track B: ids that start with "rv-" are held actions (a spend or a
  // public post), decided through review.resolve. Approving one makes the
  // gateway carry the action out, so the reply says what happened.
  if (isReviewId(parsed.id)) {
    const decision = parsed.decision === "deny" ? "deny" : "approve";
    try {
      const outcome = (await callGateway({
        method: "review.resolve",
        params: { id: parsed.id, decision, decidedBy: resolvedBy, via: "chat" },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Chat approval (${resolvedBy})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      })) as { status?: string; preview?: string; resultSummary?: string | null } | null;
      return { shouldContinue: false, reply: { text: describeReviewOutcome(parsed.id, outcome) } };
    } catch (err) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Could not decide ${parsed.id}: ${String(err)}` },
      };
    }
  }

  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
