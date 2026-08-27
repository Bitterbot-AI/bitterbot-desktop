import type { GatewayRequestHandlers } from "./types.js";
/**
 * PLAN-41 Phase 2: doctor findings over RPC for the Repairs card. Read-only;
 * runs the fast local doctor subset (see doctor-findings.ts) with a short
 * cache so a polling UI can't stampede the checks.
 */
import { collectRepairFindings } from "../../commands/doctor-findings.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.findings": async ({ respond }) => {
    try {
      respond(true, await collectRepairFindings(), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
