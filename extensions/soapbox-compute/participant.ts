import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { createSoapboxHandlers } from "../../src/gateway/server-methods/soapbox.js";
import { SoapboxClient } from "../../src/infra/soapbox-client.js";
import {
  parseSoapboxConnection,
  soapboxOperatorEnvironment,
  verifySoapboxConnection,
} from "../../src/infra/soapbox-connection.js";

export function registerParticipant(api: BitterbotPluginApi, directory: string) {
  const connection = parseSoapboxConnection(
    JSON.parse(readFileSync(path.join(directory, "connection.json"), "utf8")),
  );
  const client = new SoapboxClient(connection.url, connection.token);
  Object.assign(process.env, {
    BITTERBOT_SOAPBOX_ESCROW: connection.escrow,
    BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256: connection.escrow_code_sha256,
    BITTERBOT_SOAPBOX_RPC_URL: connection.rpc_url,
  });
  for (const [name, handler] of Object.entries(
    createSoapboxHandlers(api.config.tools?.wallet, { client, role: connection.role }),
  ))
    api.registerGatewayMethod(name, handler);
  if (connection.role === "buyer") return;
  const binary = api.pluginConfig?.binary;
  if (typeof binary !== "string" || !path.isAbsolute(binary))
    throw new Error("Operator binary must be an absolute path");
  const config = path.join(directory, "worker.json");
  const worker = JSON.parse(readFileSync(config, "utf8"));
  if (!worker.sandbox || worker.allow_unsafe_host)
    throw new Error("Operators require isolated workloads");
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  const start = async () => {
    try {
      verifySoapboxConnection(connection, await client.status());
      if (stopped) return;
      const log = openSync(path.join(directory, "worker.log"), "a", 0o600);
      try {
        child = spawn(binary, ["worker", "--config", config, "--coordinator", connection.url], {
          env: soapboxOperatorEnvironment(connection.token, process.env),
          stdio: ["ignore", log, log],
        });
      } finally {
        closeSync(log);
      }
      child.once("error", () =>
        api.logger.error("Soapbox operator could not start; check binary and worker.log"),
      );
      child.once("exit", () => {
        if (!stopped) timer = setTimeout(() => void start(), 5000);
      });
    } catch {
      api.logger.error(
        "Soapbox operator enrollment unavailable or mismatched; retrying in 10 seconds",
      );
      if (!stopped) timer = setTimeout(() => void start(), 10000);
    }
  };
  api.registerService({
    id: "soapbox-operator",
    start() {
      stopped = false;
      void start();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  });
}
