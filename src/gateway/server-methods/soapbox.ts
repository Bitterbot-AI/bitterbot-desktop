import type { WalletConfig } from "../../config/types.wallet.js";
import {
  soapboxClientFromEnv,
  type SoapboxJob,
  type SoapboxClient,
} from "../../infra/soapbox-client.js";
import { withSoapboxOperation } from "../../infra/soapbox-transition.js";
import { assertApprovedSoapboxQuote } from "../../services/soapbox-payment.js";
import { createSoapboxWallet, getSoapboxWalletStatus } from "../../services/soapbox-wallet.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

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
          !gatewayClient.connect.scopes?.includes("operator.admin") ||
          gatewayClient.connect.client?.mode?.trim().toLowerCase() === "backend" ||
          (typeof params.via === "string" && params.via.trim().toLowerCase() === "chat")
        )
          throw new Error("Compute funding requires operator.admin");
        requireBuyer();
        const client = getClient();
        if (!client) throw new Error("Soapbox is disabled");
        const job = await client.request<SoapboxJob>("GET", `/v1/jobs/${id(params.id)}`);
        if (!job.payment || job.status !== "awaiting_payment")
          throw new Error("Job is not awaiting USDC funding");
        if (
          !Number.isFinite(job.deadline) ||
          !Number.isFinite(job.payment.expires) ||
          Math.min(job.deadline!, job.payment.expires) <= Date.now() / 1000
        )
          throw new Error("Funding deadline expired; request a fresh quote");
        assertApprovedSoapboxQuote(params.approval, job.payment);
        const result = await withSoapboxOperation(async () => {
          const wallet = await createSoapboxWallet(mainWallet, job.payment!);
          const funding = await wallet.fundSoapbox!(job.payment!);
          const updated = await client.request<SoapboxJob>(
            "POST",
            `/v1/jobs/${id(params.id)}/payment`,
            {},
          );
          return { funding, job: updated };
        });
        respond(true, result);
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
    "soapbox.requote": async ({ params, respond }) => {
      try {
        requireBuyer();
        const client = getClient();
        if (!client) throw new Error("Soapbox is disabled");
        const jobId = id(params.id);
        // Refresh chain state before cancelling: an earlier funding attempt may have succeeded.
        const job = await client.request<SoapboxJob>("POST", `/v1/jobs/${jobId}/payment`, {});
        if (
          !job.payment ||
          job.spec.mode.kind !== "paid_usdc" ||
          !job.deadline ||
          job.deadline > Date.now() / 1000 ||
          job.attempts !== 0 ||
          !["awaiting_payment", "cancelled", "refunded"].includes(job.status) ||
          !job.spec.resources
        )
          throw new Error(
            "Only expired, unexecuted quotes can be replaced. Refresh payment status first.",
          );
        const cancelled = ["cancelled", "refunded"].includes(job.status)
          ? job
          : await client.request<SoapboxJob>("POST", `/v1/jobs/${jobId}/cancel`, {});
        if (!["cancelled", "refunded"].includes(cancelled.status))
          throw new Error(
            "The previous payment must finish refunding before requesting a new quote",
          );
        respond(
          true,
          await client.request<SoapboxJob>("POST", "/v1/jobs", {
            // Retrying after a lost response returns the same replacement, even after a restart.
            idempotency_key: `requote-${jobId}`,
            mode: job.spec.mode,
            workload: job.spec.workload,
            resources: job.spec.resources,
          }),
        );
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
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
