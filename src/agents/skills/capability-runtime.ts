/**
 * PLAN-13 Phase B.6: factory that wires capability gate + enforcer to the
 * runtime systems they depend on (peer reputation, grants store).
 *
 * The gate (load-time) and the enforcer (dispatch-time) both want a
 * trust-tier lookup and a grants accessor. Constructing these by hand at
 * each call site would scatter knowledge of those systems through the
 * runner; this module hides the dependency graph behind a single factory.
 *
 * Usage:
 *   const runtime = createCapabilityRuntime({ peerReputation, grantsStore, notify });
 *   buildWorkspaceSkillSnapshot(workspaceDir, { ...opts, capabilityGate: runtime.gateContext });
 *   const enforcer = runtime.buildEnforcerContext(activeSkillEntries);
 *   const tools = wrapToolsWithCapabilityEnforcer(rawTools, enforcer);
 */

import type { BitterbotConfig } from "../../config/config.js";
import type { PeerReputationManager } from "../../memory/peer-reputation.js";
import type { EnforcerContext } from "./capability-enforcer.js";
import type { CapabilityGateContext } from "./capability-gate.js";
import type {
  CapabilityAxis,
  CapabilityGrant,
  CapabilityGrantsStore,
} from "./capability-grants.js";
import type { SkillEntry } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadSkillProvenance } from "./capability-gate.js";
import { CapabilityGrantsStore as CapabilityGrantsStoreImpl } from "./capability-grants.js";
import {
  type EffectiveCapabilityProfile,
  type SkillTrustTier,
  resolveCapabilityProfile,
} from "./capability-profile.js";

const log = createSubsystemLogger("skills/capability-runtime");

export type CapabilityRuntimeOptions = {
  /** Reputation manager. May be null on cold-start before subsystems wire up. */
  peerReputation: PeerReputationManager | null;
  /** Persisted operator grants. Optional; absence == no grants applied. */
  grantsStore?: CapabilityGrantsStore | null;
  /** Optional sink for "skill blocked" / "tool denied" messages. */
  notify?: (message: string) => void;
  /**
   * Optional: record a runtime denial back to reputation. The default
   * implementation maps the call into the same `recordTrustEdge` channel
   * the bridge uses for failed verifications. Pass `false` to opt out.
   */
  reputationFeedback?: ((denial: { capability: CapabilityAxis }) => void) | false;
};

export type CapabilityRuntime = {
  /**
   * Pass to `buildWorkspaceSkillSnapshot({ capabilityGate })` to enable
   * the load-time gate on every snapshot build.
   */
  gateContext: CapabilityGateContext;
  /**
   * Build a per-turn enforcer context. The runtime closes over the active
   * skill entries, so changes between turns reflect immediately at the
   * next invocation without restarting the enforcer.
   */
  buildEnforcerContext(activeSkillEntries: SkillEntry[]): EnforcerContext;
};

export function createCapabilityRuntime(opts: CapabilityRuntimeOptions): CapabilityRuntime {
  const { peerReputation, grantsStore, notify, reputationFeedback } = opts;

  const getTrustTier = (pubkey: string): SkillTrustTier => {
    if (!peerReputation) return "untrusted";
    return peerReputation.getTrustLevel(pubkey);
  };

  const getGrants = (contentHash: string): CapabilityGrant[] => {
    return grantsStore?.listForSkill(contentHash) ?? [];
  };

  const gateContext: CapabilityGateContext = {
    getTrustTier,
    getGrants,
    // PLAN-13 Phase B.7: surface blocked-skill notifications inline.
    // Same callback as the dispatch enforcer so a single sink covers both
    // load-time and runtime denials.
    notifyBlocked: notify,
  };

  const recordDenial =
    reputationFeedback === false
      ? undefined
      : (reputationFeedback ??
        ((denial) => {
          // Default: log a generic negative trust edge against every
          // active P2P publisher whose skill could plausibly have
          // motivated the call. We don't have attribution at the LLM
          // boundary (the unsolved problem in PLAN-13 §B.5), so the
          // conservative thing is to spread a small penalty across the
          // active set. Implementation lives behind the closure that
          // builds the enforcer context (it has the active set in scope).
          // This top-level default is a no-op; the per-context override
          // below carries the actual logic.
          void denial;
        }));

  return {
    gateContext,
    buildEnforcerContext(activeSkillEntries: SkillEntry[]): EnforcerContext {
      // Pre-compute the active P2P profiles once per turn. The enforcer's
      // activeP2PProfiles getter closes over this so per-call overhead is
      // a single array deref.
      const activeP2PProfiles: EffectiveCapabilityProfile[] = [];
      const activePublishers: string[] = [];
      for (const entry of activeSkillEntries) {
        const provenance = loadSkillProvenance(entry.skill);
        if (!provenance) continue; // skip locally-authored skills entirely
        const tier = getTrustTier(provenance.authorPubkey);
        const grants = getGrants(provenance.contentHash);
        activeP2PProfiles.push(
          resolveCapabilityProfile({
            declared: entry.metadata?.capabilities,
            tier,
            grants,
          }),
        );
        activePublishers.push(provenance.authorPubkey);
      }

      const ctx: EnforcerContext = {
        activeP2PProfiles: () => activeP2PProfiles,
      };

      // Wire reputation feedback. Without attribution we apply a small
      // negative trust edge to every active P2P publisher when a denial
      // fires. This biases the system away from "load skills together"
      // patterns that produce unexpected denials, while keeping the
      // penalty per-publisher small enough that one false positive
      // doesn't sink a legitimate peer.
      if (reputationFeedback !== false && peerReputation && activePublishers.length > 0) {
        ctx.recordDenial = (denial) => {
          if (reputationFeedback) {
            try {
              reputationFeedback(denial);
            } catch {
              // best-effort
            }
            return;
          }
          for (const pubkey of activePublishers) {
            try {
              peerReputation.recordTrustEdge("local", pubkey, 0.3);
            } catch {
              // best-effort
            }
          }
        };
      } else if (recordDenial) {
        ctx.recordDenial = recordDenial;
      }

      // Wire the operator notification.
      if (notify) {
        ctx.notifyDenial = notify;
      }

      return ctx;
    },
  };
}

/**
 * Convenience factory: pull the peer reputation manager + DB out of the
 * memory subsystem and build a ready-to-use runtime. Returns null if the
 * memory subsystem is not available (cold start, minimal-test gateway).
 *
 * This is the recommended call site for runners that already touch the
 * memory manager for other reasons (endocrine state, hormones). The
 * underlying MemoryIndexManager.get is purpose-cached, so calling this
 * alongside resolveEndocrineState does not add a second initialization.
 */
export async function createCapabilityRuntimeFromMemory(opts: {
  config: BitterbotConfig | undefined;
  agentId: string | undefined;
  /** Sink for "tool denied" / "skill blocked" notifications. */
  notify?: (message: string) => void;
}): Promise<CapabilityRuntime | null> {
  // Without an agent id we cannot key the memory manager, and the runtime
  // would have nowhere to read peer reputation from. Degrade gracefully
  // (returns null) so callers can continue without the enforcer.
  if (!opts.agentId) return null;
  try {
    const { MemoryIndexManager } = await import("../../memory/manager.js");
    const manager = await MemoryIndexManager.get({
      cfg: opts.config ?? {},
      agentId: opts.agentId,
      purpose: "status",
    });
    if (!manager) return null;
    // Reach for the private peer reputation + db. We use the same dynamic-
    // access pattern that resolveEndocrineState uses for the hormonal
    // manager, to avoid widening the public surface of MemoryIndexManager
    // for a single feature wire-up.
    const m = manager as unknown as {
      peerReputationManager?: PeerReputationManager | null;
      db?: import("node:sqlite").DatabaseSync;
    };
    const peerReputation = m.peerReputationManager ?? null;
    const grantsStore = m.db ? new CapabilityGrantsStoreImpl(m.db) : null;
    return createCapabilityRuntime({
      peerReputation,
      grantsStore,
      notify: opts.notify,
    });
  } catch (err) {
    log.debug(`createCapabilityRuntimeFromMemory failed: ${String(err)}`);
    return null;
  }
}
