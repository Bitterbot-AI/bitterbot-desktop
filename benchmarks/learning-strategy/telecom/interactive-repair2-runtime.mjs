import { runRepairAttempt as runOriginal } from "./interactive-repair-runtime.mjs";
export { ARMS, summarizeRepairs, verifyRepairSequence } from "./interactive-repair-runtime.mjs";

// v1 is frozen with a rejected provider schema. Preserve its local validation and semantics;
// remove only the unsupported wire-schema keyword. The prompt still states the same bound.
export function portableRequest(request) {
  const result = structuredClone(request);
  delete result.output_config.format.schema.properties.actions.maxItems;
  return result;
}

export function runRepairAttempt(options) {
  const provider = options.provider;
  return runOriginal({
    ...options,
    provider: {
      call: (request, args) => provider.call(portableRequest(request), args),
    },
  });
}
