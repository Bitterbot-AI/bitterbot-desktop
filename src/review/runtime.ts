/**
 * The gateway's one ReviewService: the store on disk, the policy from config,
 * spend grants as standing permission, and delivery to the Control UI and the
 * requesting session (PLAN-53 Track B).
 */

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Classification } from "./classify.js";
import { createDefaultExecutors } from "./executors.js";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy, ReviewService } from "./service.js";
import { ReviewStore } from "./store.js";

const log = createSubsystemLogger("review");

type Broadcast = (event: "review.requested" | "review.resolved", payload: unknown) => void;

let service: ReviewService | null = null;
let broadcastFn: Broadcast | null = null;

/** The gateway installs its broadcaster once the WS server is up. */
export function setReviewBroadcast(fn: Broadcast | null): void {
  broadcastFn = fn;
}

export function resolveReviewPolicy(cfg = loadConfig()): ReviewPolicy {
  const review = cfg.review ?? {};
  return {
    spend: review.spend ?? DEFAULT_REVIEW_POLICY.spend,
    publish: review.publish ?? DEFAULT_REVIEW_POLICY.publish,
    ttlMs:
      typeof review.ttlHours === "number" && review.ttlHours > 0
        ? review.ttlHours * 3_600_000
        : DEFAULT_REVIEW_POLICY.ttlMs,
  };
}

/**
 * A spend grant the owner signed earlier that covers this payee and amount
 * means the owner already decided; asking again would be noise.
 */
async function coveredByStandingGrant(c: Classification): Promise<boolean> {
  if (c.cls !== "spend" || !c.payee || c.amountUsd === undefined) {
    return false;
  }
  try {
    const cfg = loadConfig();
    const { getMemorySearchManager } = await import("../memory/index.js");
    const { manager } = await getMemorySearchManager({ cfg, agentId: resolveDefaultAgentId(cfg) });
    const db = (manager as unknown as { getPaymentsDb?: () => unknown } | null)?.getPaymentsDb?.();
    if (!db) {
      return false;
    }
    const { SpendGrantStore } = await import("../payments/grants/spend-grant-store.js");
    const { verifyEd25519 } = await import("../payments/ap2/ed25519.js");
    const store = new SpendGrantStore(db as never);
    const found = store.activeGrantFor({ payee: c.payee, amountUsd: c.amountUsd, verifyEd25519 });
    if (found.grant) {
      store.recordUsage(found.grant.claims.grant_id, c.amountUsd);
      return true;
    }
    return false;
  } catch (err) {
    // No grant store, no standing permission. The person gets asked.
    log.debug(`grant lookup unavailable: ${String(err)}`);
    return false;
  }
}

export function getReviewService(): ReviewService {
  service ??= new ReviewService({
    store: ReviewStore.open(),
    executors: createDefaultExecutors(),
    standingPermission: coveredByStandingGrant,
    broadcast: (event, payload) => broadcastFn?.(event, payload),
    notifySession: (sessionKey, text, contextKey) => {
      try {
        enqueueSystemEvent(text, { sessionKey, contextKey });
      } catch (err) {
        log.debug(`session notify failed: ${String(err)}`);
      }
    },
  });
  return service;
}

/** Test seam. */
export function resetReviewServiceForTest(next: ReviewService | null = null): void {
  service = next;
}
