import path from "node:path";
import type { BitterbotConfig } from "../../../config/config.js";
import { VERSION } from "../../../version.js";
import { resolveAgentConfig, resolveAgentDir } from "../../agent-scope.js";
import { resolveSandboxConfigForAgent } from "../../sandbox/config.js";
import { learningHash } from "./contracts.js";

const CONTEXT_TOKENS = 16000;
// Sampling defaults support providers that reject non-default temperature/top_p/top_k.
const MODEL_PARAMS = { maxTokens: 4096 };

export function packageHostConfiguration(config: BitterbotConfig, agent: string): string {
  return learningHash(
    JSON.parse(
      JSON.stringify({
        hostRuntime: {
          engine: "bitterbot-in-tree/1",
          release: VERSION,
          node: process.versions.node,
        },
        model: config.skills?.collective?.validationModel ?? null,
        models: config.models ?? null,
        tools: config.tools ?? null,
        agentTools: resolveAgentConfig(config, agent)?.tools ?? null,
        sandbox: resolveSandboxConfigForAgent(config, agent),
        generation: {
          contextTokens: CONTEXT_TOKENS,
          params: MODEL_PARAMS,
          thinking: "off",
          toolCache: false,
        },
      }),
    ),
  );
}

/** Preserve every ordinary authorization layer; trial instrumentation further narrows tools. */
export function isolatedPackageConfig(
  config: BitterbotConfig,
  agent: string,
  workspace: string,
  model: string,
  hasPackage = false,
  sandboxImage?: string,
): BitterbotConfig {
  const agentTools = resolveAgentConfig(config, agent)?.tools;
  const sandbox = resolveSandboxConfigForAgent(config, agent);
  return {
    models: config.models,
    auth: config.auth,
    plugins: { enabled: false },
    tools: {
      ...config.tools,
      elevated: { enabled: false },
      exec: { ...config.tools?.exec, host: "sandbox" },
    },
    agents: {
      defaults: {
        model: { primary: model, fallbacks: [] },
        contextTokens: CONTEXT_TOKENS,
        models: { [model]: { params: MODEL_PARAMS } },
        memorySearch: { enabled: false },
        toolCache: { enabled: false },
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "rw",
          docker: {
            image: sandboxImage ?? sandbox.docker.image,
            user:
              typeof process.getuid === "function" && typeof process.getgid === "function"
                ? `${process.getuid()}:${process.getgid()}`
                : undefined,
            network: "none",
            readOnlyRoot: true,
            capDrop: ["ALL"],
            pidsLimit: 64,
            memory: "512m",
            cpus: 1,
            binds: hasPackage ? [`${path.join(workspace, "skill")}:/workspace/skill:ro`] : [],
          },
        },
      },
      list: [
        {
          id: agent,
          workspace,
          agentDir: resolveAgentDir(config, agent),
          tools: {
            ...agentTools,
            elevated: { enabled: false },
            exec: { ...agentTools?.exec, host: "sandbox" },
          },
        },
      ],
    },
  };
}
