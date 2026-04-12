import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded-runner/run.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { resolveSessionTranscriptPath } from "../../config/sessions/paths.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => {
    const sessionKey = value.sessionKey.trim();
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const runId = randomUUID();

    void (async () => {
      try {
        const cfg = loadConfig();
        const agentId = value.agentId ?? resolveDefaultAgentId(cfg);
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const sessionId = `hook-${runId}`;
        const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
        const timeoutMs = value.timeoutSeconds
          ? value.timeoutSeconds * 1_000
          : DEFAULT_HOOK_TIMEOUT_MS;

        const result = await runEmbeddedPiAgent({
          sessionId,
          sessionKey,
          agentId,
          sessionFile,
          workspaceDir,
          config: cfg,
          prompt: value.message,
          model: value.model,
          thinkLevel: value.thinking as "off" | "minimal" | "low" | "medium" | "high" | undefined,
          timeoutMs,
          runId,
          messageChannel: value.channel,
          messageTo: value.to,
          requireExplicitMessageTarget: !value.deliver,
          disableMessageTool: !value.deliver,
          lane: "hook",
        });

        const hasError = result.meta?.error != null || result.meta?.aborted;
        const summaryText =
          result.payloads?.[0]?.text?.trim() ||
          result.meta?.error?.message?.trim() ||
          (hasError ? "error" : "ok");
        const summary = summaryText;
        const status = hasError ? "error" : "ok";
        const prefix = status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${runId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${runId}:error` });
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
