import type { BatchRequest } from "../../compute/mesh-work.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const computeMeshHandlers: GatewayRequestHandlers = Object.fromEntries(
  ["status", "grant", "revoke", "submit", "batch", "cancel"].map((action) => [
    `soapbox.mesh.${action}`,
    async ({ client, params, context, respond }) => {
      if (
        client?.connect.role !== "operator" ||
        !client.connect.scopes?.includes("operator.admin")
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Compute mesh requires operator.admin"),
        );
        return;
      }
      const mesh = context.computeMesh;
      if (!mesh) {
        if (action === "status")
          respond(true, {
            enabled: true,
            ready: false,
            error: "P2P Compute unavailable. Enable P2P and install the matching orchestrator.",
            peers: [],
            batches: [],
            activity: [],
            pools: [],
            projects: [],
          });
        else
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Compute mesh unavailable"));
        return;
      }
      try {
        let result: unknown;
        switch (action) {
          case "status":
            result = mesh.status();
            break;
          case "grant":
            await mesh.grant(
              String(params.peerId),
              params.pools as string[],
              params.projects as string[],
            );
            result = mesh.status();
            break;
          case "revoke":
            await mesh.revoke(String(params.peerId));
            result = mesh.status();
            break;
          case "submit":
            result = mesh.submit(params as BatchRequest);
            break;
          case "batch":
            result = mesh.store.batch(String(params.id));
            break;
          case "cancel":
            mesh.cancel(String(params.id));
            result = mesh.status();
            break;
        }
        respond(true, result);
      } catch {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Compute action failed. Check the selected peers, scopes and local coordinator version.",
          ),
        );
      }
    },
  ]),
);
