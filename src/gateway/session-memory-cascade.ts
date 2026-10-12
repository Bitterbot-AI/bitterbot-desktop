/**
 * PLAN-55 §3.5b: deleting a conversation removes what was learned only from
 * it.
 *
 * Called by `sessions.delete` (with `deleteTranscript`, the default). The
 * transcript's memories are collected before it is archived, while they can
 * still be found by its path. The cascade then runs only for the files the
 * archive step actually moved away (named in its result AND gone from their
 * original path): a rename that failed leaves the transcript, its memories
 * and every fact resting on them untouched. The cascade waits for the
 * memory maintenance lock, and the RPC waits up to 4 seconds for it (then
 * answers `pending`; the cascade completes on its own). The memory manager
 * runs the forget cascade over them (owner-controls.forgetSessionMemories):
 * facts whose only evidence was the conversation are retired (soft), owner-tier
 * facts are never retired, and the facts that survive are returned so the
 * caller can show them.
 *
 * Who reaches this, and with what strength (`initiator`, PLAN-55 Phase 3
 * review M4): the Control UI's delete and the CLI are the owner (`owner`,
 * the default): facts are retired with `evidence_removed`, which propagates
 * like the owner's own retire. Automatic housekeeping passes `system`: the
 * subagent cleanup (`cleanup: "delete"` and the archive sweep) and
 * `bitterbot doctor`'s probe cleanup. A system delete retires evidence-empty
 * facts with `evidence_removed_system`, which propagates like the agent's
 * retire (no preference is deleted, no stale marks), and writes no
 * suppression. Owner-tier facts are never retired by either. Not wired, on
 * purpose: session reset (the transcript is archived, not deleted, and the
 * conversation can still be read), store retention pruning (removes index
 * entries, not transcripts), and the memory sync dropping chunks of a
 * transcript that disappeared from disk (a moved or unreadable sessions
 * directory looks the same and must not retire every fact).
 *
 * Best-effort: a failure here is reported in the result, never fails the
 * delete.
 */

import fs from "node:fs";
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

export type SessionDeleteInitiator = "owner" | "system";

type CascadeManager = {
  ownerForgetSession: (
    files: string[],
    opts?: {
      /** Runs after collection; returns the files confirmed archived (only those are forgotten). */
      onCollected?: () => string[] | void;
      initiator?: SessionDeleteInitiator;
    },
  ) => Promise<{
    counts: { chunks: number };
    retiredFacts: Array<{ key: string; value: string }>;
    survivors: Array<{ key: string; value: string; reason: "owner" | "other_evidence" }>;
  }>;
};

/** How long sessions.delete waits for the cascade before answering `pending`. */
export const SESSION_CASCADE_WAIT_MS = 4_000;

/**
 * The candidate transcripts the archive step really moved: an archived path
 * for it is in the archive result and the original path is gone.
 * archiveSessionTranscripts swallows a failed rename, so its result alone
 * is not proof.
 */
export function confirmedArchivedFiles(
  candidates: string[],
  archived: string[],
  exists: (file: string) => boolean = fs.existsSync,
): string[] {
  return candidates.filter(
    (file) => archived.some((a) => a.startsWith(`${file}.`)) && !exists(file),
  );
}

/**
 * Run the cascade for a deleted conversation around its archive step:
 * collect the transcript's memories, archive the transcript (`archive`),
 * then wait up to `waitMs` for the cascade. The archive always runs.
 */
export async function deleteSessionWithMemoryCascade(params: {
  agentId: string;
  files: string[];
  archive: () => string[];
  /** Who asked for the delete (see the module comment). Default `owner`. */
  initiator?: SessionDeleteInitiator;
  waitMs?: number;
  openManager?: (agentId: string) => Promise<CascadeManager | null>;
  /** Test hook for the "original path gone" check. */
  exists?: (file: string) => boolean;
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
  // The archive runs exactly once: from the manager's onCollected (so the
  // cascade sees what it moved), or below when the cascade failed first.
  let archivedFiles: string[] | null = null;
  const archiveOnce = (): string[] => {
    archivedFiles ??= params.archive();
    return archivedFiles;
  };
  let markArchived!: () => void;
  const archivedSignal = new Promise<void>((resolve) => {
    markArchived = resolve;
  });
  const run = manager
    .ownerForgetSession(params.files, {
      initiator: params.initiator ?? "owner",
      onCollected: () => {
        try {
          return confirmedArchivedFiles(params.files, archiveOnce(), params.exists);
        } finally {
          markArchived();
        }
      },
    })
    .then(
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
  await Promise.race([archivedSignal, run]);
  const archived = archiveOnce();
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
