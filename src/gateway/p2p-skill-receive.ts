/**
 * The live receive path for peer skills: orchestrator `skill_received` →
 * ingestSkill → dashboard accounting → crystal-level ingestion.
 *
 * Extracted from server-startup.ts so the wiring is testable. In particular,
 * ingestSkill's self-loopback guard only works if it is handed this node's
 * publish key; for months it was not (audit finding F15), so our own skill
 * echoed back by a re-publishing peer would land in review as an anonymous
 * peer skill and penalize our own key.
 */

import type { SkillEnvelope, ingestSkill as IngestSkillFn } from "../agents/skills/ingest.js";
import type { BitterbotConfig } from "../config/config.js";

type ReputationManager = Parameters<typeof IngestSkillFn>[0]["reputationManager"];

export type SkillReceiveDeps = {
  /** Cached orchestrator identity; `pubkey` is the key we publish skills under. */
  getIdentity: () => Promise<{ pubkey: string }>;
  /** Defaults to the live config (lazy import, as the original inline handler did). */
  loadConfig?: () => BitterbotConfig;
  workspaceDir?: string;
  /** Late-bound: the memory backend wires the bridge after startup. */
  getSkillNetworkBridge: () =>
    | {
        getPeerReputation: () => ReputationManager | null;
        ingestNetworkSkill: (envelope: SkillEnvelope) => void;
      }
    | null
    | undefined;
  log: { warn: (msg: string) => void };
};

export function createSkillReceivedHandler(deps: SkillReceiveDeps) {
  let ownPublishPubkey: string | undefined;

  const resolveOwnPubkey = async (): Promise<string | undefined> => {
    // A skill can arrive before the startup identity fetch resolves;
    // getIdentity() is cached, so asking again costs nothing.
    ownPublishPubkey ??= await deps
      .getIdentity()
      .then((identity) => identity.pubkey)
      .catch(() => undefined);
    return ownPublishPubkey;
  };

  return {
    /** Prime from the startup identity fetch. */
    setOwnPublishPubkey(pubkey: string) {
      ownPublishPubkey = pubkey;
    },
    async handle(event: unknown): Promise<void> {
      const { ingestSkill, shouldBridgeIngest } = await import("../agents/skills/ingest.js");
      const { recordIngestOutcome } = await import("../agents/skills/ingest-stats.js");
      const loadConfig = deps.loadConfig ?? (await import("../config/config.js")).loadConfig;
      const envelope = event as SkillEnvelope;
      const bridge = deps.getSkillNetworkBridge();
      const result = await ingestSkill({
        envelope,
        config: loadConfig(),
        workspaceDir: deps.workspaceDir,
        ownPublishPubkey: await resolveOwnPubkey(),
        // The live reputation manager, so a genuine peer receipt is counted
        // (peer_reputation.skills_received) and graduated trust can
        // auto-accept verified peers.
        reputationManager: bridge?.getPeerReputation() ?? undefined,
      }).catch((err) => {
        deps.log.warn(`P2P skill ingestion failed: ${String(err)}`);
        return null;
      });
      // Dashboard accounting: skills vs messages, and what we decided.
      recordIngestOutcome(envelope, result);

      // PLAN-44 Phase 3: only an ACCEPTED envelope becomes a crystal. A
      // quarantined one used to become an `active`, recall-visible chunk while
      // its file sat in review; skills.incoming.accept routes it here instead.
      if (bridge && shouldBridgeIngest(result)) {
        try {
          bridge.ingestNetworkSkill(envelope);
        } catch (err) {
          deps.log.warn(`Skill network bridge ingestion failed: ${String(err)}`);
        }
      }
    },
  };
}
