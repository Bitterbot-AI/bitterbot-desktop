/**
 * The agent hands the browser to the owner and waits (PLAN-53 A3).
 *
 * A login, a CAPTCHA, a second factor or a payment confirmation is the
 * person's to do. The agent's `browser` tool call with action "handoff" opens
 * a request in the review queue, which puts a card in the Control UI; the call
 * then waits here while the person takes over in the live view and returns
 * when they hand back. Because the tool call itself waits, the agent's turn
 * carries on afterwards with everything it had: no resume, no second run.
 *
 * The waits are bounded so a request nobody sees does not eat the whole run.
 */

import { isUserInControl } from "../browser/takeover.js";
import { getReviewService } from "./runtime.js";
import type { ReviewContext, ReviewService } from "./service.js";

/** How long the owner has to take over before the agent is told nobody came. */
export const HANDOFF_ACCEPT_MS = 3 * 60_000;
/**
 * The longest the agent's tool call waits in total. A run lasts 10 minutes by
 * default; this leaves room to say something useful afterwards.
 */
export const HANDOFF_MAX_MS = 8 * 60_000;

export type HandoffOutcome =
  /** The owner took over and handed back. */
  | { kind: "completed"; id: string; seconds: number }
  /** The owner has the browser and is still working in it. */
  | { kind: "still_in_control"; id: string }
  | { kind: "declined"; id: string }
  /** Nobody took over in time. */
  | { kind: "timed_out"; id: string };

type HandoffService = Pick<
  ReviewService,
  "openHandoff" | "acceptHandoff" | "finishHandoff" | "expireHandoff" | "get"
>;

export type HandoffDeps = {
  service: HandoffService;
  isUserInControl: (profile: string) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps = (): HandoffDeps => ({
  service: getReviewService(),
  isUserInControl,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export async function runBrowserHandoff(
  args: {
    reason: string;
    profile: string;
    url?: string;
    ctx?: ReviewContext;
    signal?: AbortSignal;
    acceptMs?: number;
    maxMs?: number;
    pollMs?: number;
  },
  deps: HandoffDeps = defaultDeps(),
): Promise<HandoffOutcome> {
  const acceptMs = args.acceptMs ?? HANDOFF_ACCEPT_MS;
  const maxMs = Math.max(args.maxMs ?? HANDOFF_MAX_MS, acceptMs);
  const pollMs = args.pollMs ?? 500;
  const { service } = deps;

  const { action } = service.openHandoff({
    reason: args.reason,
    profile: args.profile,
    url: args.url,
    ctx: args.ctx ?? {},
    // The row outlives the accept window only if the owner took over.
    ttlMs: acceptMs,
  });
  const id = action.id;
  const startedAt = deps.now();
  let acceptedAt: number | null = null;

  for (;;) {
    if (args.signal?.aborted) {
      if (acceptedAt === null) {
        service.expireHandoff(id);
      } else {
        service.finishHandoff(id, {
          ok: false,
          summary: "The agent's run ended while the owner had the browser.",
        });
      }
      throw new Error("the run was stopped while waiting for the browser handoff");
    }

    const inControl = deps.isUserInControl(args.profile);
    const elapsed = deps.now() - startedAt;

    if (acceptedAt === null) {
      if (inControl) {
        // Taking control is the acceptance, however the person got there.
        service.acceptHandoff(id, { decidedBy: "owner", decidedVia: "takeover" });
        acceptedAt = deps.now();
        continue;
      }
      const status = service.get(id)?.status;
      if (status === undefined || status === "denied") {
        return { kind: "declined", id };
      }
      if (status === "expired" || elapsed >= acceptMs) {
        if (status === "approved") {
          // Accepted on the card, but the browser was never taken.
          service.finishHandoff(id, {
            ok: false,
            summary: "The request was accepted, but nobody took the browser.",
          });
        } else {
          service.expireHandoff(id);
        }
        return { kind: "timed_out", id };
      }
    } else if (!inControl) {
      const seconds = Math.max(1, Math.round((deps.now() - acceptedAt) / 1000));
      service.finishHandoff(id, {
        ok: true,
        summary: `The owner worked in the browser for ${seconds} s and handed it back.`,
      });
      return { kind: "completed", id, seconds };
    } else if (elapsed >= maxMs) {
      service.finishHandoff(id, {
        ok: true,
        summary: "The owner took the browser and was still working when the agent stopped waiting.",
      });
      return { kind: "still_in_control", id };
    }

    await deps.sleep(pollMs);
  }
}

/** What the agent reads as the result of its handoff call. */
export function describeHandoffOutcome(outcome: HandoffOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return (
        `HANDOFF-COMPLETE (${outcome.id}): the owner took over the browser for ${outcome.seconds} s and handed it back. ` +
        "The page has probably changed: take a fresh snapshot before you act on it."
      );
    case "still_in_control":
      return (
        `HANDOFF-IN-PROGRESS (${outcome.id}): the owner has the browser and is still working in it. ` +
        "Do not act on the page. End your turn and ask them to tell you when they are done."
      );
    case "declined":
      return (
        `HANDOFF-DECLINED (${outcome.id}): the owner chose not to take over. ` +
        "Do not ask again and do not try to get past the page yourself. Tell them what is blocking you."
      );
    case "timed_out":
      return (
        `HANDOFF-UNANSWERED (${outcome.id}): nobody took over the browser in time. ` +
        "Do not try to get past the page yourself. Tell the user what you need them to do; " +
        'they can use "Take over" in the Control UI\'s Browser tab and then message you.'
      );
  }
}
