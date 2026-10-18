import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSoapboxHandlers } from "../../src/gateway/server-methods/soapbox.js";
import { SoapboxClient } from "../../src/infra/soapbox-client.js";
import { LocalOperatorService } from "../../src/services/soapbox-local-operator.js";

export function registerLocalOperator(api: BitterbotPluginApi, directory: string) {
  const binary = api.pluginConfig?.binary;
  if (typeof binary !== "string" || !path.isAbsolute(binary))
    throw new Error("Absolute operator binary required");
  const settings = JSON.parse(readFileSync(path.join(directory, "mesh-operator.json"), "utf8"));
  if (
    settings.chain_id !== 84532 ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.url) ||
    !/^[a-f0-9]{64}$/.test(settings.admin)
  )
    throw new Error("Invalid local operator");
  const client = new SoapboxClient(settings.url, settings.admin);
  for (const [method, handler] of Object.entries(
    createSoapboxHandlers(undefined, { client, role: "operator" }),
  )) {
    if (method !== "soapbox.status") api.registerGatewayMethod(method, handler);
  }
  api.registerGatewayMethod("soapbox.status", async ({ respond }) => {
    try {
      respond(true, { ...(await client.status()), local_operator: true });
    } catch {
      respond(true, { enabled: true, local_operator: true, nodes: [], jobs: [] });
    }
  });
  const service = new LocalOperatorService(directory, binary, (message) =>
    api.logger.warn(message),
  );
  api.registerService({
    id: "soapbox-local-operator",
    start: () => service.start(),
    stop: () => service.stop(),
  });
}
