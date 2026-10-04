/**
 * The review stage of the tool-call hook (PLAN-53 B1). Runs first, fails
 * closed for classified actions, and never touches anything else.
 */

import { classifyToolCall } from "./classify.js";
import { getReviewService, resolveReviewPolicy } from "./runtime.js";
import { holdMessage, type ReviewContext } from "./service.js";

export type StageOutcome = { blocked: true; reason: string } | { blocked: false };

export async function runReviewStage(args: {
  toolName: string;
  params: unknown;
  ctx?: ReviewContext;
}): Promise<StageOutcome> {
  // The pure classifier decides whether this call is any of our business, so
  // an unclassified tool never pays for the store or the config.
  const classification = classifyToolCall(args.toolName, args.params);
  if (!classification) {
    return { blocked: false };
  }
  // A call the tool would reject is the agent's to fix, not the owner's to
  // decide: asking a person to approve "send to (no address)" helps nobody.
  if (classification.missing?.length) {
    return {
      blocked: true,
      reason:
        `The ${args.toolName} call is missing required parameter(s): ${classification.missing.join(", ")}. ` +
        "Nothing was sent and nothing was queued for approval. Check the tool's parameter names and call it again.",
    };
  }
  try {
    const outcome = await getReviewService().consider(
      args.toolName,
      args.params,
      args.ctx ?? {},
      resolveReviewPolicy(),
    );
    if (outcome.kind === "hold") {
      return { blocked: true, reason: holdMessage(outcome.action, outcome.created) };
    }
    return { blocked: false };
  } catch (err) {
    // A reviewed action with no working review is not allowed to proceed.
    return {
      blocked: true,
      reason:
        `This action needs the owner's approval, but the review service failed: ${String(err)}. ` +
        "It was not performed. Do not retry; tell the user.",
    };
  }
}
