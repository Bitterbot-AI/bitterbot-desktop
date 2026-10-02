/**
 * PLAN-52: contract-suite wiring for the owned ("bitterbot") engine.
 * Filled in by Phase 3 (session layer); until then the variant is not run.
 */

import type { ContractOptions, SessionLike } from "./harness.js";

export async function createOwnedContractSession(
  _options: ContractOptions,
  _file: string,
): Promise<SessionLike> {
  throw new Error("the bitterbot engine is not built yet (PLAN-52 Phase 3)");
}
