/**
 * PLAN-20: Built-in pre-action interceptors registered at gateway startup.
 *
 * These ship inside the gateway binary (compiled TS), bound to specific
 * skill names that may also have a SKILL.md authoring file in the
 * `skills/` directory for documentation. The implementation is here, not
 * in the SKILL.md directory, because dynamic loading of user-authored
 * .ts interceptors at runtime requires a sandbox we haven't built yet
 * (gated on issue #21).
 */

import { getInterceptorRegistry } from "../interceptor-registry.js";
import { calibrateClaimConfidence } from "./calibrate-claim-confidence.js";
import { protocolQuietInGroups } from "./protocol-quiet-in-groups.js";
import { recallBeforeClaim } from "./recall-before-claim.js";
import { routeByQueryShape } from "./route-by-query-shape.js";

let registered = false;

export function registerBuiltinInterceptors(): void {
  if (registered) return;
  registered = true;
  const registry = getInterceptorRegistry();
  registry.register(recallBeforeClaim, "builtin");
  registry.register(routeByQueryShape, "builtin");
  registry.register(protocolQuietInGroups, "builtin");
  registry.register(calibrateClaimConfidence, "builtin");
}

export function unregisterBuiltinInterceptorsForTest(): void {
  registered = false;
  const registry = getInterceptorRegistry();
  registry.unregisterBySkill("recall-before-claim");
  registry.unregisterBySkill("route-by-query-shape");
  registry.unregisterBySkill("protocol-quiet-in-groups");
  registry.unregisterBySkill("calibrate-claim-confidence");
}
