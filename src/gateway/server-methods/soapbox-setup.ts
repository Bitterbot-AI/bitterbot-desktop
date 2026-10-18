import type { SoapboxSetup } from "../../services/soapbox-setup.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

/** Setup changes local configuration and provisions credentials: all endpoints require admin. */
export function createSoapboxSetupHandlers(setup: SoapboxSetup): GatewayRequestHandlers {
  const actions: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    status: () => setup.status(),
    "operator.enable": async () => {
      await setup.enableLocalOperator();
      return setup.status();
    },
    wallet: (p) => setup.wallet(p.credentials),
    import: async (p) => {
      await setup.import(p.enrollment, p.role);
      return setup.status();
    },
    "runtime.begin": async () => {
      setup.requireOperator();
      return setup.runtime.begin();
    },
    "runtime.chunk": async (p) => {
      setup.requireOperator();
      return setup.runtime.chunk(p.id, p.offset, p.data);
    },
    "runtime.prepare": async (p) => {
      setup.requireOperator();
      await setup.runtime.prepare(p.id);
      return setup.status();
    },
    "runtime.bundled": async () => {
      await setup.prepareBundledRuntime();
      return setup.status();
    },
    activate: () => setup.activate(),
  };
  return Object.fromEntries(
    Object.entries(actions).map(([action, run]) => [
      `soapbox.setup.${action}`,
      async ({ client, params, respond }) => {
        if (
          client?.connect.role !== "operator" ||
          !client.connect.scopes?.includes("operator.admin")
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Compute setup requires operator.admin"),
          );
          return;
        }
        try {
          respond(
            true,
            await (action === "status" ? run(params) : setup.mutate(() => run(params))),
          );
        } catch (error) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              error instanceof Error ? error.message : "Compute setup failed",
            ),
          );
        }
      },
    ]),
  );
}
