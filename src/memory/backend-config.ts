import type { BitterbotConfig } from "../config/config.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
} from "../config/types.memory.js";

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
};

const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";

export function resolveMemoryBackendConfig(params: {
  cfg: BitterbotConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  return { backend: "builtin", citations };
}
