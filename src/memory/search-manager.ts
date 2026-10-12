import type { BitterbotConfig } from "../config/config.js";
import type { MemorySearchManager } from "./types.js";

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: BitterbotConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

/**
 * The manager if one is already open for this agent; never builds one.
 * PLAN-55 Phase 1: the reply path reads the ledger after a turn only when
 * something already opened it.
 */
export async function peekMemorySearchManager(params: {
  cfg: BitterbotConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await import("./manager.js");
    return { manager: MemoryIndexManager.peek(params) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}
