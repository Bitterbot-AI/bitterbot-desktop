import type { WalletConfig } from "../../config/types.wallet.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  soapboxClientFromEnv,
  type SoapboxJob,
  type SoapboxClient,
} from "../../infra/soapbox-client.js";
import { assertApprovedSoapboxQuote } from "../../services/soapbox-payment.js";
import { createSoapboxWallet, getSoapboxWalletStatus } from "../../services/soapbox-wallet.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid Soapbox identifier");
  return value;
}

type Route = (params: Record<string, unknown>) => {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};
const routes: Record<string, Route> = {
  "soapbox.payment.refresh": (params) => ({
    method: "POST",
    path: `/v1/jobs/${id(params.id)}/payment`,
    body: {},
  }),
  "soapbox.job": (params) => ({ method: "GET", path: `/v1/jobs/${id(params.id)}` }),
  "soapbox.jobs": () => ({ method: "GET", path: "/v1/jobs" }),
  "soapbox.submit": (params) => ({ method: "POST", path: "/v1/jobs", body: params }),
  "soapbox.cancel": (params) => ({
    method: "POST",
    path: `/v1/jobs/${id(params.id)}/cancel`,
    body: {},
  }),
  "soapbox.worker.pause": (params) => {
    if (typeof params.paused !== "boolean") throw new Error("paused must be a boolean");
    return {
      method: "POST",
      path: `/v1/workers/${id(params.id)}/pause`,
      body: { paused: params.paused },
    };
  },
  "soapbox.artifact.put": (params) => ({ method: "POST", path: "/v1/artifacts", body: params }),
  "soapbox.artifact.get": (params) => ({ method: "GET", path: `/v1/artifacts/${id(params.id)}` }),
};

export function createSoapboxHandlers(
  mainWallet?: WalletConfig,
  options?: {
    client: SoapboxClient;
    role: "buyer" | "operator";
  },
): GatewayRequestHandlers {
  const getClient = () => options?.client ?? soapboxClientFromEnv();
  const requireBuyer = () => {
    if (options?.role === "operator")
      throw new Error("Operator setup cannot access or spend a buyer wallet");
  };
  return {
    "soapbox.wallet": async ({ respond }) => {
      try {
        requireBuyer();
        if (!getClient()) throw new Error("Soapbox is disabled");
        respond(true, await getSoapboxWalletStatus());
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "soapbox.payment.fund": async ({ params, respond, client: gatewayClient }) => {
      try {
        if (
          gatewayClient?.connect.role !== "operator" ||
          !gatewayClient.connect.scopes?.includes("operator.admin")
        )
          throw new Error("Compute funding requires operator.admin");
        requireBuyer();
        const client = getClient();
        if (!client) throw new Error("Soapbox is disabled");
        const job = await client.request<SoapboxJob>("GET", `/v1/jobs/${id(params.id)}`);
        if (!job.payment || job.status !== "awaiting_payment")
          throw new Error("Job is not awaiting USDC funding");
        assertApprovedSoapboxQuote(params.approval, job.payment);
        const wallet = await createSoapboxWallet(mainWallet, job.payment);
        const funding = await wallet.fundSoapbox!(job.payment);
        const updated = await client.request<SoapboxJob>(
          "POST",
          `/v1/jobs/${id(params.id)}/payment`,
          {},
        );
        respond(true, { funding, job: updated });
      } catch {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Compute funding did not complete. Use an admin connection, review the current quote, and refresh its payment state before retrying.",
          ),
        );
      }
    },
    "soapbox.status": async ({ respond }) => {
      try {
        const client = getClient();
        respond(true, client ? await client.status() : { enabled: false });
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    ...Object.fromEntries(
      Object.entries(routes).map(
        ([method, route]) =>
          [
            method,
            async ({ params, respond }) => {
              try {
                if (
                  [
                    "soapbox.submit",
                    "soapbox.cancel",
                    "soapbox.artifact.put",
                    "soapbox.artifact.get",
                  ].includes(method)
                )
                  requireBuyer();
                const client = getClient();
                if (!client)
                  throw new Error("Soapbox is disabled; configure it on the gateway first");
                const request = route(params);
                respond(true, await client.request(request.method, request.path, request.body));
              } catch (error) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
              }
            },
          ] as [string, GatewayRequestHandlers[string]],
      ),
    ),
  };
}

export const soapboxHandlers = createSoapboxHandlers();
