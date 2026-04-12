import type { BitterbotConfig } from "../config/config.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { AnyAgentTool } from "./tools/common.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createA2aClientTool } from "./tools/a2a-client-tool.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createArtifactTool } from "./tools/artifact-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCodeInterpreterTool } from "./tools/code-interpreter-tool.js";
import { createCuriosityResolveTool, createCuriosityStateTool } from "./tools/curiosity-tool.js";
import { createDeepRecallTool } from "./tools/deep-recall-tool.js";
import { createDreamSearchTool, createDreamStatusTool } from "./tools/dream-tool.js";
import {
  createEmotionalAnchorTool,
  createRecallEmotionalAnchorTool,
} from "./tools/emotional-anchor-tool.js";
import { createExpandMessageTool } from "./tools/expand-message-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMemoryStatusTool } from "./tools/memory-status-tool.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools/memory-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createWalletTool } from "./tools/wallet-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { createCompleteTool, createPlanTool } from "./tools/workflow-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export function createBitterbotTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: BitterbotConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
}): AnyAgentTool[] {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
            : undefined,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
      });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
    }),
    createCanvasTool(),
    createArtifactTool(),
    createCodeInterpreterTool(),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
    createExpandMessageTool(),
    createCompleteTool(),
    createPlanTool(),
  ];

  // Memory tools — hardwired (no plugin indirection)
  const memoryOpts = { config: options?.config, agentSessionKey: options?.agentSessionKey };
  for (const tool of [
    createMemorySearchTool(memoryOpts),
    createMemoryGetTool(memoryOpts),
    createMemoryStatusTool(memoryOpts),
    createDreamSearchTool(memoryOpts),
    createDreamStatusTool(memoryOpts),
    createCuriosityStateTool(memoryOpts),
    createCuriosityResolveTool(memoryOpts),
    createEmotionalAnchorTool(memoryOpts),
    createRecallEmotionalAnchorTool(memoryOpts),
    createDeepRecallTool(memoryOpts),
  ]) {
    if (tool) {
      tools.push(tool);
    }
  }

  const walletTool = createWalletTool({
    config: options?.config,
    agentSessionKey: options?.agentSessionKey,
  });
  if (walletTool) {
    tools.push(walletTool);
  }

  const a2aClientTool = createA2aClientTool({ config: options?.config });
  if (a2aClientTool) {
    tools.push(a2aClientTool);
  }

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
