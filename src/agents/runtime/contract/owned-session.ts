/**
 * PLAN-52: contract-suite wiring for the owned ("bitterbot") engine: the
 * owned session, loop, and transcript store, set up the way the embedded
 * runner sets them up (tool-result guard, header identity, wrapped tools,
 * request auth on the stream function).
 */

import fs from "node:fs";
import path from "node:path";
import { streamSimple } from "@mariozechner/pi-ai";
import { prepareSessionManagerForRun } from "../../embedded-runner/session-manager-init.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { createOffloadCompactionPolicy } from "../compaction/offload-compaction.js";
import { DEFAULT_OFFLOAD_SETTINGS } from "../compaction/offload-policy.js";
import { createSummaryCompactionPolicy } from "../compaction/summary-policy.js";
import type { StreamFn } from "../loop/index.js";
import { openTranscript } from "../open-transcript.js";
import { AgentSession, type SessionStore } from "../session/session.js";
import { toRuntimeTools } from "../session/tools.js";
import type { ContractOptions, SessionLike } from "./harness.js";
import { CONTRACT_API_KEY, CONTRACT_SESSION_ID } from "./scripted-model.js";

export async function createOwnedContractSession(
  options: ContractOptions,
  file: string,
): Promise<SessionLike> {
  const cwd = path.join(options.dir, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const hadSessionFile = fs.existsSync(file);
  const store = guardSessionManager(openTranscript(file, "bitterbot"), {
    agentId: "main",
    allowSyntheticToolResults: true,
  });
  await prepareSessionManagerForRun({
    sessionManager: store,
    sessionFile: file,
    hadSessionFile,
    sessionId: CONTRACT_SESSION_ID,
    cwd,
  });
  // Request auth is applied on the stream function, as the runner does.
  const streamFn: StreamFn = (model, context, streamOptions) =>
    streamSimple(model, context, { ...streamOptions, apiKey: CONTRACT_API_KEY });
  const session = new AgentSession({
    model: options.script.model,
    thinkingLevel: "off",
    systemPrompt: options.systemPrompt ?? "contract system prompt",
    tools: toRuntimeTools(options.tools ?? []),
    store: store as unknown as SessionStore,
    settings: {
      retry: {
        enabled: options.retry?.enabled ?? true,
        maxRetries: options.retry?.maxRetries ?? 3,
        baseDelayMs: options.retry?.baseDelayMs ?? 5,
      },
      compaction: {
        enabled: options.compaction?.enabled ?? true,
        reserveTokens: options.compaction?.reserveTokens ?? 20_000,
        keepRecentTokens: options.compaction?.keepRecentTokens ?? 20_000,
      },
    },
    streamFn,
    resolveRequestAuth: async () => ({ ok: true, apiKey: CONTRACT_API_KEY }),
    ...(options.offload
      ? {
          compactionPolicy: createOffloadCompactionPolicy({
            settings: { ...DEFAULT_OFFLOAD_SETTINGS, ...options.offload.settings },
            summaryMode: options.offload.summaryMode ?? "always",
            sessionFile: () => file,
            sessionId: () => CONTRACT_SESSION_ID,
            heartbeatPrompts: [],
            fixedTokens: () => 0,
            fallback: createSummaryCompactionPolicy(),
          }),
        }
      : {}),
  });
  return session as unknown as SessionLike;
}
