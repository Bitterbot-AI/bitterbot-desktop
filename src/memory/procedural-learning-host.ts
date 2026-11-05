import type { BitterbotConfig } from "../config/config.js";
import { resolveLearningConfig } from "./procedural-learning-contract.js";
import type { ProceduralLearning } from "./procedural-learning.js";

/** Host/plugin entry point. Register adapters during gateway startup for each
 * agent. Models and peer packets never receive this capability. */
export async function getProceduralLearning(params: {
  cfg: BitterbotConfig;
  agentId: string;
}): Promise<ProceduralLearning | null> {
  if (resolveLearningConfig(params.cfg.memory?.proceduralLearning).mode === "off") return null;
  const { getMemorySearchManager } = await import("./search-manager.js");
  const { manager } = await getMemorySearchManager(params);
  return manager?.proceduralLearning?.() ?? null;
}
