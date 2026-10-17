import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import plugin from "../../extensions/soapbox-compute/index.js";
import { SoapboxClient, type SoapboxStatus } from "../infra/soapbox-client.js";
import { createPluginRegistry, type PluginRecord } from "../plugins/registry.js";
import { coreGatewayHandlers } from "./server-methods.js";

// Isolate unrelated gateways: this suite tests the real core registry and Compute plugin.
vi.mock("./server-methods/agent-runtime.js", () => ({ agentRuntimeHandlers: {} }));
vi.mock("./server-methods/agent.js", () => ({ agentHandlers: {} }));
vi.mock("./server-methods/agents.js", () => ({ agentsHandlers: {} }));
vi.mock("./server-methods/browser.js", () => ({ browserHandlers: {} }));
vi.mock("./server-methods/channels.js", () => ({ channelsHandlers: {} }));
vi.mock("./server-methods/chat.js", () => ({ chatHandlers: {} }));
vi.mock("./server-methods/circles.js", () => ({ circlesHandlers: {} }));
vi.mock("./server-methods/config.js", () => ({ configHandlers: {} }));
vi.mock("./server-methods/connect.js", () => ({ connectHandlers: {} }));
vi.mock("./server-methods/cron.js", () => ({ cronHandlers: {} }));
vi.mock("./server-methods/devices.js", () => ({ deviceHandlers: {} }));
vi.mock("./server-methods/doctor.js", () => ({ doctorHandlers: {} }));
vi.mock("./server-methods/dream.js", () => ({ dreamHandlers: {} }));
vi.mock("./server-methods/exec-approvals.js", () => ({ execApprovalsHandlers: {} }));
vi.mock("./server-methods/forage.js", () => ({ forageHandlers: {} }));
vi.mock("./server-methods/guards.js", () => ({ guardsHandlers: {} }));
vi.mock("./server-methods/health.js", () => ({ healthHandlers: {} }));
vi.mock("./server-methods/logs.js", () => ({ logsHandlers: {} }));
vi.mock("./server-methods/management.js", () => ({ managementHandlers: {} }));
vi.mock("./server-methods/models-auth.js", () => ({ modelsAuthHandlers: {} }));
vi.mock("./server-methods/models.js", () => ({ modelsHandlers: {} }));
vi.mock("./server-methods/nodes.js", () => ({ nodeHandlers: {} }));
vi.mock("./server-methods/projects.js", () => ({ projectsHandlers: {} }));
vi.mock("./server-methods/send.js", () => ({ sendHandlers: {} }));
vi.mock("./server-methods/sessions.js", () => ({ sessionsHandlers: {} }));
vi.mock("./server-methods/skills.js", () => ({ skillsHandlers: {} }));
vi.mock("./server-methods/system.js", () => ({ systemHandlers: {} }));
vi.mock("./server-methods/talk.js", () => ({ talkHandlers: {} }));
vi.mock("./server-methods/tts.js", () => ({ ttsHandlers: {} }));
vi.mock("./server-methods/update.js", () => ({ updateHandlers: {} }));
vi.mock("./server-methods/usage.js", () => ({ usageHandlers: {} }));
vi.mock("./server-methods/voicewake.js", () => ({ voicewakeHandlers: {} }));
vi.mock("./server-methods/wallet.js", () => ({ walletHandlers: {} }));
vi.mock("./server-methods/web.js", () => ({ webHandlers: {} }));
vi.mock("./server-methods/wizard.js", () => ({ wizardHandlers: {} }));
vi.mock("./server-methods/workspace.js", () => ({ workspaceHandlers: {} }));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Compute plugin registration in the current gateway", () => {
  it.each(["buyer", "operator"] as const)(
    "owns participant handlers for %s without collisions",
    async (role) => {
      for (const name of ["ESCROW", "ESCROW_CODE_SHA256", "RPC_URL"])
        vi.stubEnv(`BITTERBOT_SOAPBOX_${name}`, "");
      const directory = await mkdtemp(path.join(tmpdir(), "soapbox-registration-"));
      directories.push(directory);
      await writeFile(
        path.join(directory, "connection.json"),
        JSON.stringify({
          version: 1,
          role,
          id: "tester",
          url: "https://compute.example",
          token: "c".repeat(64),
          address: `0x${"1".repeat(40)}`,
          chain_id: 84532,
          escrow: `0x${"2".repeat(40)}`,
          escrow_code_sha256: "a".repeat(64),
          rpc_url: "https://sepolia.base.org",
        }),
      );
      await writeFile(
        path.join(directory, "worker.json"),
        JSON.stringify({ sandbox: { image: "test" } }),
      );
      const snapshot = {
        settlement: "usdc_escrow",
        principal: { id: "tester", roles: [role === "buyer" ? "submitter" : "worker"] },
      } as SoapboxStatus;
      vi.spyOn(SoapboxClient.prototype, "status").mockResolvedValue(snapshot);
      const request = vi.spyOn(SoapboxClient.prototype, "request");
      const registry = createPluginRegistry({
        coreGatewayHandlers,
        runtime: {} as PluginRuntime,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      const record: PluginRecord = {
        id: plugin.id,
        name: "Compute",
        source: "test",
        origin: "bundled",
        enabled: true,
        status: "loaded",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: true,
      };
      plugin.register(
        registry.createApi(record, {
          config: {},
          pluginConfig: {
            mode: "participant",
            stateDirectory: directory,
            binary: path.join(directory, "soapbox"),
          },
        }),
      );
      expect(
        Object.keys(coreGatewayHandlers).filter((name) => name.startsWith("soapbox.")),
      ).toEqual([]);
      expect(registry.registry.diagnostics).toEqual([]);
      const respond = vi.fn();
      await registry.registry.gatewayHandlers["soapbox.status"]({
        params: {},
        respond,
      } as GatewayRequestHandlerOptions);
      expect(respond).toHaveBeenCalledWith(true, snapshot);
      if (role === "operator") {
        respond.mockClear();
        await registry.registry.gatewayHandlers["soapbox.wallet"]({
          params: {},
          respond,
        } as GatewayRequestHandlerOptions);
        expect(respond.mock.calls[0][0]).toBe(false);
        expect(request).not.toHaveBeenCalled();
      }
    },
  );
});
