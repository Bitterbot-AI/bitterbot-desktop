/**
 * PLAN-55 §3.5b: deleting a conversation removes what was learned only from
 * it.
 *
 * Called by `sessions.delete` (with `deleteTranscript`, the default). The
 * transcript's memories are collected before it is archived, while they can
 * still be found by its path; the cascade itself waits for the memory
 * maintenance lock, and the RPC waits up to 4 seconds for it (then answers
 * `pending`; the cascade completes on its own). The memory manager runs the forget cascade over them
 * (owner-controls.forgetSessionMemories): facts whose only evidence was the
 * conversation are retired (soft, reason `evidence_removed`), owner-tier
 * facts are never retired, and the facts that survive are returned so the
 * caller can show them.
 *
 * Who reaches this: the Control UI's delete, `bitterbot doctor`'s probe
 * cleanup, and the subagent cleanup (`cleanup: "delete"` and the archive
 * sweep), all through `sessions.delete`. The same rule holds for all of them
 * (retire below the owner tier, never the owner tier). Not wired, on
 * purpose: session reset (the transcript is archived, not deleted, and the
 * conversation can still be read), store retention pruning (removes index
 * entries, not transcripts), and the memory sync dropping chunks of a
 * transcript that disappeared from disk (a moved or unreadable sessions
 * directory looks the same and must not retire every fact).
 *
 * Best-effort: a failure here is reported in the result, never fails the
 * delete.
 */

import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/session-memory");

export type SessionMemoryCascadeResult =
  | {
      ok: true;
      forgottenMemories: number;
      retiredFacts: Array<{ key: string; value: string }>;
      survivors: Array<{ key: string; value: string; reason: "owner" | "other_evidence" }>;
    }
  /** Still running (waiting behind a dream cycle, say); it finishes on its own. */
  | { ok: true; pending: true }
  | { ok: false; error: string };

type CascadeManager = {
  ownerForgetSession: (
    files: string[],
    opts?: { onCollected?: () => void },
  ) => Promise<{
    counts: { chunks: number };
    retiredFacts: Array<{ key: string; value: string }>;
    survivors: Array<{ key: string; value: string; reason: "owner" | "other_evidence" }>;
  }>;
};

/** How long sessions.delete waits for the cascade before answering `pending`. */
export const SESSION_CASCADE_WAIT_MS = 4_000;

/**
 * Run the cascade for a deleted conversation around its archive step:
 * collect the transcript's memories, archive the transcript (`archive`),
 * then wait up to `waitMs` for the cascade. The archive always runs.
 */
export async function deleteSessionWithMemoryCascade(params: {
  agentId: string;
  files: string[];
  archive: () => string[];
  waitMs?: number;
  openManager?: (agentId: string) => Promise<CascadeManager | null>;
}): Promise<{ archived: string[]; memory: SessionMemoryCascadeResult | null }> {
  let manager: CascadeManager | null = null;
  if (params.files.length > 0) {
    try {
      manager = await (params.openManager ?? defaultOpenManager)(params.agentId);
    } catch (err) {
      log.warn(`session delete: memory unavailable: ${String(err)}`);
      return {
        archived: params.archive(),
        memory: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  if (!manager || typeof manager.ownerForgetSession !== "function") {
    return { archived: params.archive(), memory: null };
  }
  let markCollected!: () => void;
  const collected = new Promise<void>((resolve) => {
    markCollected = resolve;
  });
  const run = manager.ownerForgetSession(params.files, { onCollected: () => markCollected() }).then(
    (result): SessionMemoryCascadeResult => {
      if (result.counts.chunks > 0 || result.retiredFacts.length > 0) {
        log.info(
          `session delete: forgot ${result.counts.chunks} memories, retired ${result.retiredFacts.length} fact(s), kept ${result.survivors.length}`,
        );
      }
      return {
        ok: true,
        forgottenMemories: result.counts.chunks,
        retiredFacts: result.retiredFacts,
        survivors: result.survivors,
      };
    },
    (err: unknown): SessionMemoryCascadeResult => {
      log.warn(`session delete: memory cascade failed: ${String(err)}`);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    },
  );
  // The transcript's memories are found by its path in the index, so they
  // are collected before the archive renames it.
  await Promise.race([collected, run]);
  const archived = params.archive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const memory = await Promise.race([
    run,
    new Promise<SessionMemoryCascadeResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: true, pending: true }),
        params.waitMs ?? SESSION_CASCADE_WAIT_MS,
      );
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { archived, memory };
}

async function defaultOpenManager(agentId: string): Promise<CascadeManager | null> {
  const { getMemorySearchManager } = await import("../memory/index.js");
  const { manager } = await getMemorySearchManager({ cfg: loadConfig(), agentId });
  return (manager as unknown as CascadeManager | null) ?? null;
}
