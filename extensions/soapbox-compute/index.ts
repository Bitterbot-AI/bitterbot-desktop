import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveStateDir, resolveConfigPath } from "../../src/config/paths.js";
import { createSoapboxSetupHandlers } from "../../src/gateway/server-methods/soapbox-setup.js";
import { createSoapboxHandlers } from "../../src/gateway/server-methods/soapbox.js";
import { SoapboxSetup } from "../../src/services/soapbox-setup.js";
import { registerLocalOperator } from "./local-operator.js";
import { registerParticipant } from "./participant.js";

export default {
  id: "soapbox-compute",
  register(api: BitterbotPluginApi) {
    const repository = api.pluginConfig?.repository;
    const directory = api.pluginConfig?.stateDirectory;
    const setupOnly =
      api.pluginConfig?.mode === "setup" || (!api.pluginConfig?.mode && !repository);
    const setup = new SoapboxSetup({
      root: path.join(resolveStateDir(), "compute/setup"),
      configPath: resolveConfigPath(),
      mainWallet: api.config.tools?.wallet,
      bundledRuntimeArchive:
        typeof api.pluginConfig?.bundledRuntimeArchive === "string"
          ? api.pluginConfig.bundledRuntimeArchive
          : undefined,
      configuredRole: setupOnly
        ? undefined
        : api.pluginConfig?.mode === "participant"
          ? "participant"
          : api.pluginConfig?.mode === "mesh-operator"
            ? "mesh-operator"
            : "pilot",
    });
    for (const [name, handler] of Object.entries(createSoapboxSetupHandlers(setup)))
      api.registerGatewayMethod(name, handler);
    api.registerService({ id: "soapbox-setup", start() {}, stop: () => setup.stop() });
    if (setupOnly) {
      api.registerGatewayMethod("soapbox.status", ({ respond }) =>
        respond(true, { enabled: false }),
      );
      return;
    }
    if (api.pluginConfig?.mode === "mesh-operator") {
      if (typeof directory !== "string" || !path.isAbsolute(directory))
        throw new Error("Absolute stateDirectory required");
      registerLocalOperator(api, directory);
      return;
    }
    if (api.pluginConfig?.mode === "participant") {
      if (typeof directory !== "string" || !path.isAbsolute(directory))
        throw new Error("Absolute stateDirectory required");
      registerParticipant(api, directory);
      return;
    }
    if (
      typeof repository !== "string" ||
      !path.isAbsolute(repository) ||
      typeof directory !== "string" ||
      !path.isAbsolute(directory)
    )
      throw new Error("Soapbox requires absolute repository and stateDirectory paths");
    const credentials = JSON.parse(readFileSync(path.join(directory, "credentials.json"), "utf8"));
    const { payments } = JSON.parse(readFileSync(path.join(directory, "coordinator.json"), "utf8"));
    if (payments.chain_id !== 84532 || !/^[a-f0-9]{64}$/.test(credentials.buyer))
      throw new Error("Soapbox requires its provisioned Base Sepolia coordinator");
    Object.assign(process.env, {
      BITTERBOT_SOAPBOX_ENABLED: "1",
      BITTERBOT_SOAPBOX_URL: "http://127.0.0.1:8787",
      BITTERBOT_SOAPBOX_TOKEN: credentials.buyer,
      BITTERBOT_SOAPBOX_ESCROW: payments.escrow,
      BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256: payments.escrow_code_sha256,
      BITTERBOT_SOAPBOX_RPC_URL: payments.rpc_url,
    });
    for (const [name, handler] of Object.entries(createSoapboxHandlers(api.config.tools?.wallet)))
      api.registerGatewayMethod(name, handler);

    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    const start = () => {
      const log = openSync(path.join(directory, "pilot.log"), "a", 0o600);
      try {
        child = spawn(
          process.execPath,
          [
            `--env-file=${path.join(homedir(), ".bitterbot", ".env")}`,
            "--import",
            "tsx",
            path.join(repository, "scripts/soapbox-desktop-pilot.ts"),
            "--services-only",
          ],
          {
            cwd: repository,
            env: { ...process.env, SOAPBOX_PILOT_STATE: directory },
            stdio: ["ignore", log, log],
          },
        );
      } finally {
        closeSync(log);
      }
      child.on("error", (error) => api.logger.error(`Soapbox service: ${error.message}`));
      child.on("exit", () => {
        if (!stopping) timer = setTimeout(start, 10000);
      });
    };
    api.registerService({
      id: "soapbox-compute",
      start() {
        stopping = false;
        start();
      },
      async stop() {
        stopping = true;
        clearTimeout(timer);
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 12000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      },
    });
  },
};
