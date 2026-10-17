import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { authorizeGatewayMethod } from "./server-methods.js";
import { soapboxHandlers } from "./server-methods/soapbox.js";

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

const read = new Set([
  "soapbox.status",
  "soapbox.wallet",
  "soapbox.jobs",
  "soapbox.job",
  "soapbox.artifact.get",
]);
function client(scopes: string[], role = "operator") {
  return { connect: { role, scopes } } as GatewayRequestOptions["client"];
}
describe("Soapbox RPC scopes", () => {
  it("requires admin for worker control and write for submission", () => {
    for (const method of Object.keys(soapboxHandlers)) {
      expect(authorizeGatewayMethod(method, client(["operator.admin"]))).toBeNull();
      expect(authorizeGatewayMethod(method, client(["operator.read"])) === null).toBe(
        read.has(method),
      );
      expect(authorizeGatewayMethod(method, client(["operator.write"])) === null).toBe(
        !["soapbox.worker.pause", "soapbox.payment.fund", "soapbox.payment.refresh"].includes(
          method,
        ),
      );
      expect(authorizeGatewayMethod(method, client(["operator.admin"], "node"))).not.toBeNull();
    }
  });
});
