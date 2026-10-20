/**
 * tools.output.subscribe / tools.output.unsubscribe: a Control UI window's
 * lease on tool output (PLAN-53 A4). See ../tool-output-leases.ts.
 *
 * Neither method is in the read or write scope sets, so both need
 * operator.admin: tool output is command output and file contents.
 */

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { TOOL_OUTPUT_LEASE_MS, toolOutputLeases } from "../tool-output-leases.js";
import type { GatewayRequestHandlers } from "./types.js";

export const toolOutputHandlers: GatewayRequestHandlers = {
  "tools.output.subscribe": ({ respond, client }) => {
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tool output needs a connection to send it to"),
      );
      return;
    }
    toolOutputLeases.grant(connId);
    respond(true, { ok: true, leaseMs: TOOL_OUTPUT_LEASE_MS });
  },

  "tools.output.unsubscribe": ({ respond, client }) => {
    if (client?.connId) {
      toolOutputLeases.revoke(client.connId);
    }
    respond(true, { ok: true });
  },
};
