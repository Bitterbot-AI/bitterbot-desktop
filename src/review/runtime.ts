/**
 * The gateway's one ReviewService: the store on disk, the policy from config,
 * spend grants as standing permission, and delivery to the Control UI and the
 * requesting session (PLAN-53 Track B).
 */

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { peekSessionStore, resolveStorePath } from "../config/sessions.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Classification } from "./classify.js";
import { addressesFromConfig, addressesFromSessions, KnownContacts } from "./contacts.js";
import { createDefaultExecutors } from "./executors.js";
import {
  DEFAULT_REVIEW_POLICY,
  type ReviewContext,
  type ReviewPolicy,
  ReviewService,
  type StandingPermission,
} from "./service.js";
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
    contact: review.contact ?? DEFAULT_REVIEW_POLICY.contact,
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
async function coveredByStandingGrant(c: Classification): Promise<StandingPermission> {
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
      const grantId = found.grant.claims.grant_id;
      const amountUsd = c.amountUsd;
      // Reserve now so a second call cannot spend the same allowance; a failed
      // send hands it back as an offsetting usage row.
      store.recordUsage(grantId, amountUsd);
      return { release: () => store.recordUsage(grantId, -amountUsd) };
    }
    return false;
  } catch (err) {
    // No grant store, no standing permission. The person gets asked.
    log.debug(`grant lookup unavailable: ${String(err)}`);
    return false;
  }
}

/** Rebuilding the known set reads every session; a short cache is plenty. */
const KNOWN_CONTACTS_TTL_MS = 30_000;
let knownContacts: { at: number; set: KnownContacts } | null = null;

async function loadKnownContacts(now = Date.now()): Promise<KnownContacts> {
  if (knownContacts && now - knownContacts.at < KNOWN_CONTACTS_TTL_MS) {
    return knownContacts.set;
  }
  const cfg = loadConfig();
  const set = new KnownContacts(addressesFromConfig(cfg));
  try {
    const { listAgentIds } = await import("../agents/agent-scope.js");
    for (const agentId of listAgentIds(cfg)) {
      const sessions = peekSessionStore(resolveStorePath(cfg.session?.store, { agentId }));
      for (const address of addressesFromSessions(sessions)) {
        set.add(address);
      }
    }
  } catch (err) {
    log.debug(`session contacts unavailable: ${String(err)}`);
  }
  try {
    const { readChannelAllowFromStore } = await import("../pairing/pairing-store.js");
    for (const channel of Object.keys(cfg.channels ?? {})) {
      for (const address of await readChannelAllowFromStore(channel as never)) {
        set.add({ channel, address });
      }
    }
  } catch (err) {
    log.debug(`paired contacts unavailable: ${String(err)}`);
  }
  knownContacts = { at: now, set };
  return set;
}

/**
 * A held message is carried out later by the gateway, outside the run that
 * knew which channel it was on. Record that channel with the stored call.
 */
function completeMessageParams(toolName: string, params: unknown, ctx: ReviewContext): unknown {
  if (toolName !== "message" || !params || typeof params !== "object" || !ctx.sessionKey) {
    return params;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.channel === "string" && record.channel.trim()) {
    return params;
  }
  try {
    const cfg = loadConfig();
    const agentId = ctx.agentId ?? resolveDefaultAgentId(cfg);
    const entry = peekSessionStore(resolveStorePath(cfg.session?.store, { agentId }))[
      ctx.sessionKey
    ];
    const channel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.channel;
    return channel ? { ...record, channel } : params;
  } catch {
    return params;
  }
}

export function getReviewService(): ReviewService {
  service ??= new ReviewService({
    store: ReviewStore.open(),
    executors: createDefaultExecutors(),
    standingPermission: coveredByStandingGrant,
    // Unknown on any failure: the owner is asked, which is the safe side.
    knownContact: async (recipient) => (await loadKnownContacts()).has(recipient),
    completeParams: completeMessageParams,
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
/** Test seam. */
export function resetKnownContactsForTest(): void {
  knownContacts = null;
}

export function resetReviewServiceForTest(next: ReviewService | null = null): void {
  service = next;
}
