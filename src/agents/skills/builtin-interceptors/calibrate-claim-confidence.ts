/**
 * PLAN-20 reference interceptor #4: calibrate-claim-confidence.
 *
 * Goal: when the agent's GCCRF empowerment is low AND certaintyDelta is
 * negative (we feel less certain than a step ago), rewrite confident
 * assertions into hedged ones. This is the canonical biological-state
 * binding example: no other framework has a `gccrf.empowerment` field to
 * gate on.
 */

import type { CandidateAction, PreActionInterceptor, StepContext } from "../interceptor.js";
import { MESSAGE_TOOL_NAMES } from "./message-tools.js";

const CONFIDENT_RX =
  /\b(definitely|certainly|absolutely|clearly|obviously|undoubtedly|surely|always|never|guaranteed|100%)\b/i;

const HEDGE_MAP: Record<string, string> = {
  definitely: "likely",
  certainly: "probably",
  absolutely: "in most cases",
  clearly: "it appears",
  obviously: "it seems",
  undoubtedly: "by my best read",
  surely: "probably",
  always: "typically",
  never: "rarely",
  guaranteed: "expected",
  "100%": "very likely",
};

const MESSAGE_TOOLS = MESSAGE_TOOL_NAMES;

function hedge(text: string): string {
  return text.replace(
    /\b(definitely|certainly|absolutely|clearly|obviously|undoubtedly|surely|always|never|guaranteed|100%)\b/gi,
    (match) => {
      const lower = match.toLowerCase();
      return HEDGE_MAP[lower] ?? "likely";
    },
  );
}

export const calibrateClaimConfidence: PreActionInterceptor = {
  id: "calibrate-claim-confidence:default",
  skill: "calibrate-claim-confidence",
  priority: 40,
  maxFiresPerEpisode: 6,
  tools: MESSAGE_TOOLS,

  shouldActivate(ctx: StepContext, action: CandidateAction): boolean {
    if (ctx.gccrf.empowerment >= 0.3) return false;
    if (ctx.gccrf.certaintyDelta >= 0) return false;
    const text = ctx.draftReply ?? coerceText(action.params);
    if (!text) return false;
    return CONFIDENT_RX.test(text);
  },

  intervene(ctx: StepContext, action: CandidateAction) {
    const original = ctx.draftReply ?? coerceText(action.params) ?? "";
    const hedged = hedge(original);
    // Find the text-bearing param and replace it. Common shapes are
    // { text }, { content }, { message }, { body }.
    const next: Record<string, unknown> = { ...action.params };
    for (const key of ["text", "content", "message", "body", "reply"]) {
      if (typeof next[key] === "string" && next[key] === original) {
        next[key] = hedged;
        break;
      }
    }
    return {
      type: "modify" as const,
      newParams: next,
      reason: `calibrate-claim-confidence: hedged (empowerment=${ctx.gccrf.empowerment.toFixed(2)}, certaintyDelta=${ctx.gccrf.certaintyDelta.toFixed(2)})`,
    };
  },
};

function coerceText(params: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["text", "content", "message", "body", "reply"]) {
    const v = params[key];
    if (typeof v === "string") return v;
  }
  return null;
}
