/**
 * Model registry and auth storage.
 *
 * These were pi-coding-agent's classes; they are now the owned ports in
 * `runtime/models/` (PLAN-52 Phase 5), with the same method names, so pi's
 * own session can still be handed these instances while the pi engine
 * exists. The module keeps its path because many callers import it; it moves
 * out of `engines/pi/` with the adapter.
 */
export {
  AuthStorage,
  discoverAuthStorage,
  discoverModels,
  ModelRegistry,
} from "../../models/index.js";
