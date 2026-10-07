import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  filterHeartbeatOnlyFiles,
  resolveHeartbeatLightContext,
} from "../../../infra/heartbeat-gate.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import {
  isA2aTaskSessionKey,
  isSkillEvolveValidationSessionKey,
  isSkillEvolvePeerValidationSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../../../routing/session-key.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveBitterbotAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createBitterbotCodingTools } from "../../agent-tools.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import { resolveCanonicalFactsBlock } from "../../canonical-facts-block.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { resolveBitterbotDocsPath } from "../../docs-path.js";
import {
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../embedded-subscribe.js";
import { resolveEndocrineState } from "../../endocrine-state.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { createOllamaStreamFn, OLLAMA_NATIVE_BASE_URL } from "../../ollama-stream.js";
import { resolveAgentCompaction } from "../../runtime/compaction/agent-config.js";
import { resolveHeartbeatPromptSet } from "../../runtime/compaction/heartbeat.js";
import { buildProactiveRecallPreface } from "../../runtime/compaction/transcript-recall.js";
import { installInRunBudget } from "../../runtime/context-pruning/in-run-budget.js";
import {
  applyHeartbeatStubs,
  applyStubsToMessages,
  buildPruneRecordData,
  collectHeartbeatStubs,
  collectStubRecords,
  PRUNE_RECORD_CUSTOM_TYPE,
} from "../../runtime/context-pruning/offload-stubs.js";
import { resolveRuntimeEngine } from "../../runtime/engine.js";
import { createPiSession, type EmbeddedAgentSession } from "../../runtime/engines/pi/session.js";
import { resolveCompactionReserveTokensFloor } from "../../runtime/engines/pi/settings.js";
import { toClientToolDefinitions } from "../../runtime/engines/pi/tool-definition-adapter.js";
import { openTranscript } from "../../runtime/open-transcript.js";
import { createOwnedSession } from "../../runtime/session/create.js";
import type { SessionStore } from "../../runtime/session/session.js";
import { toRuntimeClientTools, toRuntimeTools } from "../../runtime/session/tools.js";
import { estimateTokens } from "../../runtime/tokens.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { applyCanaryExposure } from "../../skills/canary-registry.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { getGlobalToolCache } from "../../tool-cache.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { isRunnerAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import { buildEmbeddedExtensionPaths } from "../extensions.js";
import { applyExtraParamsToAgent, resolveCacheTtlLabel } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeAntigravityThinkingBlocks,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { loadActiveHarnessPolicy } from "../harness-policy-store.js";
import { applyToolDescriptionOverrides, renderPromptFragments } from "../harness-policy.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { withSessionRequestAuth } from "../session-auth.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { buildEmbeddedSystemPrompt, createSystemPromptOverride } from "../system-prompt.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import {
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export function injectHistoryImagesIntoMessages(
  messages: AgentMessage[],
  historyImagesByIndex: Map<number, ImageContent[]>,
): boolean {
  if (historyImagesByIndex.size === 0) {
    return false;
  }
  let didMutate = false;

  for (const [msgIndex, images] of historyImagesByIndex) {
    // Bounds check: ensure index is valid before accessing
    if (msgIndex < 0 || msgIndex >= messages.length) {
      continue;
    }
    const msg = messages[msgIndex];
    if (msg && msg.role === "user") {
      // Convert string content to array format if needed
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
        didMutate = true;
      }
      if (Array.isArray(msg.content)) {
        // Check for existing image content to avoid duplicates across turns
        const existingImageData = new Set(
          msg.content
            .filter(
              (c): c is ImageContent =>
                c != null &&
                typeof c === "object" &&
                c.type === "image" &&
                typeof c.data === "string",
            )
            .map((c) => c.data),
        );
        for (const img of images) {
          // Only add if this image isn't already in the message
          if (!existingImageData.has(img.data)) {
            msg.content.push(img);
            didMutate = true;
          }
        }
      }
    }
  }

  return didMutate;
}

function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const prevCwd = process.cwd();
  const runAbortController = new AbortController();

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  let restoreSkillEnv: (() => void) | undefined;
  process.chdir(effectiveWorkspace);
  try {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const skillEntries = shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(effectiveWorkspace)
      : [];
    // PLAN-13 Phase B.5 runtime enforcer disabled. Its conservative-union
    // attribution model can't tell agent-baseline tool calls from skill-
    // prompt-injected ones, so loading any P2P skill that doesn't declare
    // shell/network breaks the agent's baseline (gateway, web_fetch, etc).
    // The load-time gate (capability-gate.ts) is the correct layer for
    // gating untrusted P2P skills; rewiring it into workspace loaders is a
    // separate follow-up. Re-enable here once per-call skill attribution
    // exists (PLAN-13 §B.5 follow-up).
    const capabilityEnforcer = undefined;
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    // PLAN-45 Phase 3.2: a freshly promoted (canary) skill is withheld from
    // a hash-bucketed share of runs; those runs are the monitor's control
    // cohort. Validation rollouts bypass the filter (the gate must see the
    // candidate). The exposure is journaled once per run.
    const skillsPrompt = applyCanaryExposure({
      prompt: resolveSkillsPromptForRun({
        skillsSnapshot: params.skillsSnapshot,
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        config: params.config,
        workspaceDir: effectiveWorkspace,
      }),
      runId: params.runId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      bypass: isSkillEvolveValidationSessionKey(params.sessionKey),
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const { bootstrapFiles: resolvedBootstrapFiles, contextFiles: resolvedContextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        includeHeartbeatFile: params.isHeartbeat === true,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
      });
    // Light heartbeat (token-efficiency build): HEARTBEAT.md is the only
    // workspace file a heartbeat needs; the rest of the bootstrap set
    // (GENOME/PROTOCOLS/TOOLS/MEMORY) is what made an idle tick cost ~54k tokens.
    const heartbeatLight =
      params.isHeartbeat === true &&
      resolveHeartbeatLightContext(params.config, {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
    const hookAdjustedBootstrapFiles = heartbeatLight
      ? filterHeartbeatOnlyFiles(resolvedBootstrapFiles)
      : resolvedBootstrapFiles;
    const contextFiles = heartbeatLight
      ? filterHeartbeatOnlyFiles(resolvedContextFiles)
      : resolvedContextFiles;
    const workspaceNotes: string[] | undefined = undefined;

    const agentDir = params.agentDir ?? resolveBitterbotAgentDir();

    // Check if the model supports native image input
    const modelHasVision = params.model.input?.includes("image") ?? false;
    const toolsRaw = params.disableTools
      ? []
      : createBitterbotCodingTools({
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner: params.senderIsOwner,
          sessionKey: params.sessionKey ?? params.sessionId,
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          isHeartbeat: params.isHeartbeat === true,
          runId: params.runId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
          requireExplicitMessageTarget:
            params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
          disableMessageTool: params.disableMessageTool,
          toolCache: getGlobalToolCache({
            enabled: params.config?.agents?.defaults?.toolCache?.enabled ?? true,
            maxEntries: params.config?.agents?.defaults?.toolCache?.maxEntries,
            defaultTtlMs: params.config?.agents?.defaults?.toolCache?.defaultTtlMs,
            cacheableTools: params.config?.agents?.defaults?.toolCache?.cacheableTools,
          }),
          capabilityEnforcer,
        });
    // PLAN-25: the active harness policy (config baseline + promoted evolution).
    // Behavior-neutral until a policy is promoted (no overrides, no fragments).
    const harnessPolicy = loadActiveHarnessPolicy(params.config);
    const tools = applyToolDescriptionOverrides(
      sanitizeToolsForGoogle({ tools: toolsRaw, provider: params.provider }),
      harnessPolicy,
    );
    logToolSchemasForGoogle({ tools, provider: params.provider });

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) {
          runtimeCapabilities = [];
        }
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider);
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    // PLAN-43 s3.2b: an inbound A2A task turn executes a REMOTE caller's
    // request. It must be hermetic on the prompt side too: minimal mode,
    // and NONE of the memory-derived blocks below (proactive recall is
    // steered by the caller's own message text; canonical facts and session
    // briefs are the node's private state — with zero tools the model can
    // still be asked to repeat its own system prompt back out).
    // PLAN-43 Phase 3: skill-evolution validation rollouts inject PEER
    // skill text and get the same hermetic prompt (no recall steered by
    // that text, no canonical facts or session brief handed to it).
    const remoteTaskTurn =
      isA2aTaskSessionKey(params.sessionKey) ||
      isSkillEvolveValidationSessionKey(params.sessionKey);
    // PLAN-45 2.3: the node's OWN candidate is validated under the
    // production prompt shape (all static sections, the skills index) so
    // the gate measures the pathway the runtime uses; the private,
    // nondeterministic blocks (memory, recall, canonical facts, brief) stay
    // off through the remoteTaskTurn guards below. Peer skills keep the
    // hermetic minimal prompt (PLAN-43).
    const ownValidationTurn =
      isSkillEvolveValidationSessionKey(params.sessionKey) &&
      !isSkillEvolvePeerValidationSessionKey(params.sessionKey);
    const promptMode =
      (remoteTaskTurn && !ownValidationTurn) ||
      isSubagentSessionKey(params.sessionKey) ||
      isCronSessionKey(params.sessionKey) ||
      heartbeatLight
        ? "minimal"
        : "full";
    // Someone other than the owner is talking (group member, approved contact):
    // the agent keeps its character but none of the owner's private memory.
    const guestFace = await import("../../guest-face.js");
    const guestTurn =
      !remoteTaskTurn &&
      promptMode === "full" &&
      guestFace.isGuestTurn({
        senderIsOwner: params.senderIsOwner,
        isHeartbeat: params.isHeartbeat,
        // The same resolution as runtimeChannel: the gateway's agent call sets
        // only messageChannel, inbound channel runs set messageProvider.
        messageProvider: params.messageChannel ?? params.messageProvider,
        prompt: params.prompt,
      });
    if (guestTurn && params.sessionKey) {
      // What a guest says never becomes a preference or fact about the owner.
      const { markGuestSession } = await import("../../../memory/guest-sessions.js");
      markGuestSession(params.sessionKey);
    }
    // A guest's prompt carries the genome and protocols only, never MEMORY.md.
    const promptContextFiles = guestTurn
      ? guestFace.filterGuestContextFiles(contextFiles)
      : contextFiles;
    const guestPrompt = guestTurn
      ? await (async () => {
          let hormones: { dopamine: number; cortisol: number; oxytocin: number } | undefined;
          try {
            const { MemoryIndexManager } = await import("../../../memory/manager.js");
            const manager = await MemoryIndexManager.get({
              cfg: params.config ?? {},
              agentId: sessionAgentId,
              purpose: "status",
            });
            hormones = manager?.hormonalState() ?? undefined;
          } catch {
            hormones = undefined;
          }
          return guestFace.buildGuestPrompt({
            publicCard: await guestFace.loadPublicCard(effectiveWorkspace),
            mood: guestFace.moodWord(hormones),
            senderName: params.senderName ?? undefined,
            channel: params.messageChannel ?? params.messageProvider ?? undefined,
            group: /:(group|channel):/.test(params.sessionKey ?? ""),
            canMessageOwner: true,
          });
        })().catch(() => undefined)
      : undefined;
    const docsPath = await resolveBitterbotDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;

    // Resolve endocrine state for personality modulation in system prompt.
    // Skipped entirely for remote task turns: its proactive-recall block is
    // keyed off the caller's message and its session brief is fail-open.
    const endocrineState =
      remoteTaskTurn || guestTurn
        ? undefined
        : await resolveEndocrineState({
            config: params.config,
            agentId: sessionAgentId,
            workspaceDir: effectiveWorkspace,
            // Drives involuntary proactive recall: surface what we already know about
            // this message's topic into the system prompt before the model answers.
            userMessage: params.prompt,
            // Scopes the recall cooldown to this conversation so a fresh session in
            // a warm process is not suppressed by the previous session's window.
            sessionKey: params.sessionKey ?? params.sessionId,
            // PLAN-40 funnel: dream-fact consumption stamps only in full mode
            // (minimal assembly drops the proactive block after selection).
            promptMode,
            // Heartbeat ticks must not spend embeddings on proactive recall or
            // drain the continuity gate (token-efficiency build, W2 contract).
            isHeartbeat: params.isHeartbeat === true,
          }).catch(() => undefined);

    // PLAN-33: canonical facts resolve independently of endocrine state so a
    // hormonal/recall failure can never drop the ground-truth block. Never
    // resolved for remote task turns (node-private ground truth).
    const canonicalFacts =
      remoteTaskTurn || guestTurn
        ? undefined
        : await resolveCanonicalFactsBlock({
            config: params.config,
            agentId: sessionAgentId,
            promptMode,
          }).catch(() => undefined);

    // PLAN-34 Phase 2b: idle-research findings surface deterministically on
    // the next live turn — same independence contract as canonical facts.
    // Consume ONLY on a genuine first-party live user turn (not heartbeat,
    // not subagent/cron/hook) so the one-shot brief is never drained into an
    // ephemeral or third-party transcript (Phase 2 adversarial fix).
    const { classifySessionKeyTrust } = await import("../../../memory/session-trust.js");
    const liveUserTurn =
      Boolean(params.prompt) &&
      !params.isHeartbeat &&
      classifySessionKeyTrust(params.sessionKey ?? params.sessionId ?? "") === "first_party";
    const { resolveResearchFindingsBlock, resolveBriefOwnerTurn } =
      await import("../../research-findings-block.js");
    // PLAN-40 Lane 3 owner gate — see resolveBriefOwnerTurn for why identity,
    // not session-key shape, decides.
    const ownerTurn = resolveBriefOwnerTurn({
      liveUserTurn,
      senderIsOwner: params.senderIsOwner,
      messageProvider: params.messageProvider,
    });
    const researchFindings = guestTurn
      ? undefined
      : await resolveResearchFindingsBlock({
          config: params.config,
          agentId: sessionAgentId,
          promptMode,
          liveUserTurn,
          ownerTurn,
        }).catch(() => undefined);

    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: guestPrompt
        ? [params.extraSystemPrompt, guestPrompt].filter(Boolean).join("\n\n")
        : params.extraSystemPrompt,
      ownerNumbers: guestTurn ? undefined : params.ownerNumbers,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      workspaceNotes,
      reactionGuidance,
      promptMode,
      // PLAN-44 Phase 2 (adversarial H5): a validation session must see the
      // skills index the runtime sees, or the gate measures a different
      // selection problem than production.
      skillsInMinimal: isSkillEvolveValidationSessionKey(params.sessionKey),
      sessionContext: { group: /:(group|channel):/.test(params.sessionKey ?? "") },
      runtimeInfo,
      messageToolHints,
      sandboxInfo,
      tools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles: promptContextFiles,
      memoryCitationsMode: params.config?.memory?.citations,
      endocrineState,
      canonicalFacts,
      researchFindings,
    });
    // PLAN-25: append any evolved prompt fragments to the system prompt. Empty
    // string (and thus byte-identical prompt) until a policy is promoted.
    const harnessFragments = renderPromptFragments(harnessPolicy);
    const effectiveAppendPrompt = harnessFragments
      ? `${appendPrompt}\n\n${harnessFragments}`
      : appendPrompt;
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars: resolveBootstrapMaxChars(params.config),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: params.sessionKey ?? params.sessionId,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: effectiveAppendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: promptContextFiles,
      skillsPrompt,
      tools,
    });
    const systemPromptOverride = createSystemPromptOverride(effectiveAppendPrompt);
    const systemPromptText = systemPromptOverride();

    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: EmbeddedAgentSession | undefined;
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      await prewarmSessionFile(params.sessionFile);
      // PLAN-52 Phase 1: the engine picks the transcript store; pi's session
      // layer drives the turn on either.
      const runtimeEngine = resolveRuntimeEngine(params.config, sessionAgentId);
      const agentCompaction = resolveAgentCompaction(params.config, sessionAgentId);
      sessionManager = guardSessionManager(openTranscript(params.sessionFile, runtimeEngine), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        inputProvenance: params.inputProvenance,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      });
      trackSessionManagerAccess(params.sessionFile);

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      // Call for side effects (sets compaction/pruning runtime state)
      buildEmbeddedExtensionPaths({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });

      // Get hook runner early so it's available when creating tools
      const hookRunner = getGlobalHookRunner();

      // Client tools (OpenResponses hosted tools) are recorded, not executed.
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const onClientToolCall = (toolName: string, toolParams: Record<string, unknown>) => {
        clientToolCallDetected = { name: toolName, params: toolParams };
      };
      const clientToolHookContext = { agentId: sessionAgentId, sessionKey: params.sessionKey };

      if (runtimeEngine === "bitterbot") {
        // PLAN-52: the owned session, loop, and compaction policy. It exposes
        // the same members and events the code below uses on pi's session.
        const modelRegistry = params.modelRegistry;
        const owned = createOwnedSession({
          config: params.config,
          agentId: sessionAgentId,
          model: params.model,
          thinkingLevel: mapThinkingLevel(params.thinkLevel),
          systemPrompt: systemPromptText,
          tools: [
            ...toRuntimeTools(tools),
            ...(params.clientTools
              ? toRuntimeClientTools(params.clientTools, onClientToolCall, clientToolHookContext)
              : []),
          ],
          store: sessionManager as unknown as SessionStore,
          resolveRequestAuth: (model) => modelRegistry.getApiKeyAndHeaders(model),
          findModel: (provider, modelId) => modelRegistry.find(provider, modelId),
          log: (message) => log.info(`[runtime] runId=${params.runId} ${message}`),
        });
        session = owned as unknown as typeof session;
      } else {
        const { customTools } = splitSdkTools({
          tools,
          sandboxEnabled: !!sandbox?.enabled,
        });
        const clientToolDefs = params.clientTools
          ? toClientToolDefinitions(params.clientTools, onClientToolCall, clientToolHookContext)
          : [];
        session = await createPiSession({
          cwd: resolvedWorkspace,
          settingsCwd: effectiveWorkspace,
          agentDir,
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          model: params.model,
          thinkingLevel: mapThinkingLevel(params.thinkLevel),
          customTools: [...customTools, ...clientToolDefs],
          store: sessionManager,
          systemPrompt: systemPromptText,
          minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
          toolLoopCompat: true,
        });
      }
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      // PLAN-52A: the context budget that reaches the run in flight. The loop
      // snapshots `transformContext` at run start and calls it before every
      // model call, so this is where tool-output stubs (and the truncation
      // fallback) take effect mid-turn. Assigning `agent.state.messages` from
      // the tool-end handler never did: the loop works on its own snapshot.
      try {
        const offloadCfg = agentCompaction.offload;
        const compressionCfg = params.config?.agents?.defaults?.compression;
        const contextWindowTokens = params.model.contextWindow ?? 0;
        const stubStore = sessionManager;
        if (contextWindowTokens > 0 && stubStore) {
          installInRunBudget(session.agent as Parameters<typeof installInRunBudget>[0], {
            contextWindowTokens,
            fixedTokens: Math.ceil((systemPromptText?.length ?? 0) / 4),
            estimate: (message) => {
              try {
                return estimateTokens(message);
              } catch {
                return Math.ceil(JSON.stringify(message ?? "").length / 4);
              }
            },
            settings: {
              stubsEnabled: offloadCfg?.toolOutputStubs !== false,
              ...(typeof offloadCfg?.triggerMidTurnFraction === "number"
                ? { triggerFraction: offloadCfg.triggerMidTurnFraction }
                : {}),
              ...(typeof offloadCfg?.midTurnTargetFraction === "number"
                ? { stubTargetFraction: offloadCfg.midTurnTargetFraction }
                : {}),
              ...(typeof offloadCfg?.toolOutputStubMinTokens === "number"
                ? { stubMinTokens: offloadCfg.toolOutputStubMinTokens }
                : {}),
              ...(typeof offloadCfg?.spareRecentToolResults === "number"
                ? { spareRecent: offloadCfg.spareRecentToolResults }
                : {}),
              compressionEnabled: compressionCfg?.enabled !== false,
              compression: compressionCfg,
            },
            recorded: collectStubRecords(stubStore.getBranch()),
            persist: (stubs) => {
              stubStore.appendCustomEntry(
                PRUNE_RECORD_CUSTOM_TYPE,
                buildPruneRecordData(stubs, "mid-turn"),
              );
            },
            onApplied: (event) => {
              log.info(
                `[in-run-budget] runId=${params.runId} ${event.tokensBefore}→${event.tokensAfter} est tokens ` +
                  `(new stubs=${event.newStubs}, recorded=${event.recordedStubs}, compressed=${event.compressed})`,
              );
              emitAgentEvent({
                runId: params.runId,
                stream: "compaction",
                data: { phase: "in-run-budget", ...event },
              });
            },
          });
        }
      } catch (budgetErr) {
        log.warn(`[in-run-budget] install failed: ${String(budgetErr)}`);
      }
      const activeSession = session;
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });

      // Ollama native API: bypass SDK's streamSimple and use direct /api/chat calls
      // for reliable streaming + tool calling support (#11828).
      if (params.model.api === "ollama") {
        // Use the resolved model baseUrl first so custom provider aliases work.
        const providerConfig = params.config?.models?.providers?.[params.model.provider];
        const modelBaseUrl =
          typeof params.model.baseUrl === "string" ? params.model.baseUrl.trim() : "";
        const providerBaseUrl =
          typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
        const ollamaBaseUrl = modelBaseUrl || providerBaseUrl || OLLAMA_NATIVE_BASE_URL;
        activeSession.agent.streamFn = createOllamaStreamFn(ollamaBaseUrl);
      } else {
        // Force a stable streamFn reference so vitest can reliably mock @mariozechner/pi-ai.
        activeSession.agent.streamFn = streamSimple;
      }

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        params.streamParams,
      );

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }
      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }
      // Outermost: pi >= 0.73 only resolves the API key and headers inside the
      // default streamFn we replaced above.
      activeSession.agent.streamFn = withSessionRequestAuth(
        activeSession.agent.streamFn,
        params.modelRegistry,
      );

      try {
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
        const truncated = limitHistoryTurns(
          validated,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        // Re-run tool_use/tool_result pairing repair after truncation, since
        // limitHistoryTurns can orphan tool_result blocks by removing the
        // assistant message that contained the matching tool_use.
        const limited = transcriptPolicy.repairToolUseResultPairing
          ? sanitizeToolUseResultPairing(truncated)
          : truncated;
        cacheTrace?.recordStage("session:limited", { messages: limited });
        // PLAN-52A context-pruning stage: re-apply the tool-output stubs that
        // earlier turns recorded (`bitterbot.offload-prune` entries on this
        // branch). Without this the full outputs come back every turn, because
        // the context is rebuilt from the transcript.
        let pruned = limited;
        if (agentCompaction.offload.toolOutputStubs !== false) {
          try {
            const recorded = collectStubRecords(sessionManager.getBranch());
            if (recorded.size > 0) {
              const res = applyStubsToMessages(limited, recorded);
              pruned = res.messages;
              if (res.applied > 0) {
                log.debug(
                  `[context-pruning] runId=${params.runId} re-applied ${res.applied} tool-output stub(s)`,
                );
              }
            }
          } catch (pruneErr) {
            log.warn(`[context-pruning] stub re-application failed: ${String(pruneErr)}`);
          }
        }
        // Bare heartbeat pairs an offload cut recorded are dropped again. They
        // are only ever recorded by that policy, so no setting gates this.
        try {
          const heartbeats = collectHeartbeatStubs(sessionManager.getBranch());
          if (heartbeats.length > 0) {
            const res = applyHeartbeatStubs(pruned, heartbeats);
            pruned = res.messages;
            if (res.removed > 0) {
              log.debug(
                `[context-pruning] runId=${params.runId} dropped ${res.removed} heartbeat message(s)`,
              );
            }
          }
        } catch (pruneErr) {
          log.warn(`[context-pruning] heartbeat elision failed: ${String(pruneErr)}`);
        }
        cacheTrace?.recordStage("session:pruned", { messages: pruned });
        if (pruned.length > 0) {
          activeSession.agent.state.messages = pruned;
        }
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
        });
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let timedOut = false;
      let timedOutDuringCompaction = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        runId: params.runId,
        hookRunner: getGlobalHookRunner() ?? undefined,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
        config: params.config,
        sessionKey: params.sessionKey ?? params.sessionId,
        sessionFile: params.sessionFile,
        agentId: sessionAgentId,
        channel: params.messageChannel ?? params.messageProvider,
        cacheTtl: resolveCacheTtlLabel({
          cfg: params.config,
          provider: params.provider,
          modelId: params.modelId,
          baseUrl: typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined,
        }),
        contextWindowTokens: params.model.contextWindow,
        modelRef: {
          provider: params.model.provider,
          model: params.model.id,
          ...(params.thinkLevel ? { thinkLevel: params.thinkLevel } : {}),
        },
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        getMessagingToolSentTexts,
        getMessagingToolSentTargets,
        didSendViaMessagingTool,
        getLastToolError,
        getUsageTotals,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
        senderIsOwner: params.senderIsOwner === true,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const abortTimer = setTimeout(
        () => {
          if (!isProbeSession) {
            log.warn(
              `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
            );
          }
          if (
            shouldFlagCompactionTimeout({
              isTimeout: true,
              isCompactionPendingOrRetrying: subscription.isCompacting(),
              isCompactionInFlight: activeSession.isCompacting,
            })
          ) {
            timedOutDuringCompaction = true;
          }
          abortRun(true);
          if (!abortWarnTimer) {
            abortWarnTimer = setTimeout(() => {
              if (!activeSession.isStreaming) {
                return;
              }
              if (!isProbeSession) {
                log.warn(
                  `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                );
              }
            }, 10_000);
          }
        },
        Math.max(1, params.timeoutMs),
      );

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        if (
          shouldFlagCompactionTimeout({
            isTimeout: timeout,
            isCompactionPendingOrRetrying: subscription.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          timedOutDuringCompaction = true;
        }
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // Hook runner was already obtained earlier before tool creation
      const hookAgentId =
        typeof params.agentId === "string" && params.agentId.trim()
          ? normalizeAgentId(params.agentId)
          : resolveSessionAgentIds({
              sessionKey: params.sessionKey,
              config: params.config,
            }).sessionAgentId;

      let promptError: unknown = null;
      try {
        const promptStartedAt = Date.now();

        // Run before_agent_start hooks to allow plugins to inject context
        let effectivePrompt = params.prompt;
        // PLAN-52A L1a: when part of this conversation was offloaded, put the
        // excerpts of that range that match the new message in front of it.
        // Never on heartbeats or remote task turns.
        if (
          !remoteTaskTurn &&
          params.isHeartbeat !== true &&
          agentCompaction.policy === "offload" &&
          agentCompaction.offload.proactiveRecall !== false
        ) {
          try {
            const preface = buildProactiveRecallPreface({
              sessionFile: params.sessionFile,
              sessionIdFallback: params.sessionId,
              query: params.prompt,
              heartbeatPrompts: resolveHeartbeatPromptSet(params.config),
            });
            if (preface) {
              effectivePrompt = `${preface}\n\n${effectivePrompt}`;
              log.info(
                `[transcript-recall] runId=${params.runId} injected ${preface.length} chars from the offloaded range`,
              );
            }
          } catch (recallErr) {
            log.warn(`[transcript-recall] failed: ${String(recallErr)}`);
          }
        }
        if (hookRunner?.hasHooks("before_agent_start")) {
          try {
            const hookResult = await hookRunner.runBeforeAgentStart(
              {
                prompt: params.prompt,
                messages: activeSession.messages,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
              },
            );
            if (hookResult?.prependContext) {
              effectivePrompt = `${hookResult.prependContext}\n\n${effectivePrompt}`;
              log.debug(
                `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
              );
            }
          } catch (hookErr) {
            log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
          }
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const contextMessages = sessionManager.buildSessionContext()
            .messages as unknown as AgentMessage[];
          const sanitizedOrphan = transcriptPolicy.normalizeAntigravityThinkingBlocks
            ? sanitizeAntigravityThinkingBlocks(contextMessages)
            : contextMessages;
          activeSession.agent.state.messages = sanitizedOrphan;
          log.warn(
            `Removed orphaned user message to prevent consecutive user turns. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }

        try {
          // Detect and load images referenced in the prompt for vision-capable models.
          // This eliminates the need for an explicit "view" tool call by injecting
          // images directly into the prompt when the model supports it.
          // Also scans conversation history to enable follow-up questions about earlier images.
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            historyMessages: activeSession.messages,
            maxBytes: MAX_IMAGE_BYTES,
            // Enforce sandbox path restrictions when sandbox is enabled
            sandbox:
              sandbox?.enabled && sandbox?.fsBridge
                ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                : undefined,
          });

          // Inject history images into their original message positions.
          // This ensures the model sees images in context (e.g., "compare to the first image").
          const didMutate = injectHistoryImagesIntoMessages(
            activeSession.messages,
            imageResult.historyImagesByIndex,
          );
          if (didMutate) {
            // Persist message mutations (e.g., injected history images) so we don't re-scan/reload.
            activeSession.agent.state.messages = activeSession.messages;
          }

          cacheTrace?.recordStage("prompt:images", {
            prompt: effectivePrompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length} history=${imageResult.historyImagesByIndex.size}`,
          });

          // Diagnostic: log context sizes before prompt to help debug early overflow errors.
          if (log.isEnabled("debug")) {
            const msgCount = activeSession.messages.length;
            const systemLen = systemPromptText?.length ?? 0;
            const promptLen = effectivePrompt.length;
            const sessionSummary = summarizeSessionContext(activeSession.messages);
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `historyImageMessages=${imageResult.historyImagesByIndex.size} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptText,
                  prompt: effectivePrompt,
                  historyMessages: activeSession.messages,
                  imagesCount: imageResult.images.length,
                },
                {
                  agentId: hookAgentId,
                  sessionKey: params.sessionKey,
                  sessionId: params.sessionId,
                  workspaceDir: params.workspaceDir,
                  messageProvider: params.messageProvider ?? undefined,
                },
              )
              .catch((err) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          // A stop that arrived during setup (hooks, image loading) must not be
          // followed by a prompt: session.abort() only reaches a run that
          // already exists, and the run would start with nobody able to stop it.
          if (runAbortController.signal.aborted) {
            throw makeAbortError(runAbortController.signal);
          }
          // Only pass images option if there are actually images to pass
          // This avoids potential issues with models that don't expect the images parameter
          if (imageResult.images.length > 0) {
            await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
          } else {
            await abortable(activeSession.prompt(effectivePrompt));
          }
        } catch (err) {
          promptError = err;
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        // Capture snapshot before compaction wait so we have complete messages if timeout occurs
        // Check compaction state before and after to avoid race condition where compaction starts during capture
        // Use session state (not subscription) for snapshot decisions - need instantaneous compaction status
        const wasCompactingBefore = activeSession.isCompacting;
        const snapshot = activeSession.messages.slice();
        const wasCompactingAfter = activeSession.isCompacting;
        // Only trust snapshot if compaction wasn't running before or after capture
        const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
        const preCompactionSessionId = activeSession.sessionId;

        try {
          await abortable(waitForCompactionRetry());
        } catch (err) {
          if (isRunnerAbortError(err)) {
            if (!promptError) {
              promptError = err;
            }
            if (!isProbeSession) {
              log.debug(
                `compaction wait aborted: runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          } else {
            throw err;
          }
        }

        // Append cache-TTL timestamp AFTER prompt + compaction retry completes.
        // Previously this was before the prompt, which caused a custom entry to be
        // inserted between compaction and the next prompt — breaking the
        // prepareCompaction() guard that checks the last entry type, leading to
        // double-compaction. See: https://github.com/bitterbot/bitterbot/issues/9282
        // Skip when timed out during compaction — session state may be inconsistent.
        if (!timedOutDuringCompaction) {
          const shouldTrackCacheTtl =
            params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
            isCacheTtlEligibleProvider(params.provider, params.modelId);
          if (shouldTrackCacheTtl) {
            appendCacheTtlTimestamp(sessionManager, {
              timestamp: Date.now(),
              provider: params.provider,
              modelId: params.modelId,
            });
          }
        }

        // If timeout occurred during compaction, use pre-compaction snapshot when available
        // (compaction restructures messages but does not add user/assistant turns).
        const snapshotSelection = selectCompactionTimeoutSnapshot({
          timedOutDuringCompaction,
          preCompactionSnapshot,
          preCompactionSessionId,
          currentSnapshot: activeSession.messages.slice(),
          currentSessionId: activeSession.sessionId,
        });
        if (timedOutDuringCompaction) {
          if (!isProbeSession) {
            log.warn(
              `using ${snapshotSelection.source} snapshot: timed out during compaction runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }
        messagesSnapshot = snapshotSelection.messagesSnapshot;
        sessionIdUsed = snapshotSelection.sessionIdUsed;
        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        // Run even on compaction timeout so plugins can log/cleanup
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? describeUnknownError(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
              },
            )
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // as it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .toReversed()
        .find((m) => m.role === "assistant");

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));

      if (hookRunner?.hasHooks("llm_output")) {
        hookRunner
          .runLlmOutput(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              assistantTexts,
              lastAssistant,
              usage: getUsageTotals(),
            },
            {
              agentId: hookAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              workspaceDir: params.workspaceDir,
              messageProvider: params.messageProvider ?? undefined,
            },
          )
          .catch((err) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      return {
        aborted,
        timedOut,
        timedOutDuringCompaction,
        promptError,
        sessionIdUsed,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage: getUsageTotals(),
        compactionCount: getCompactionCount(),
        // Client tool call detected (OpenResponses hosted tools)
        clientToolCall: clientToolCallDetected ?? undefined,
      };
    } finally {
      // Always tear down the session (and release the lock) before we leave this attempt.
      //
      // BUGFIX: Wait for the agent to be truly idle before flushing pending tool results.
      // pi-agent-core's auto-retry resolves waitForRetry() on assistant message receipt,
      // *before* tool execution completes in the retried agent loop. Without this wait,
      // flushPendingToolResults() fires while tools are still executing, inserting
      // synthetic "missing tool result" errors and causing silent agent failures.
      // See: https://github.com/bitterbot/bitterbot/issues/8643
      if (runAbortController.signal.aborted) {
        // Stop anything that started between the abort and this teardown, so
        // nothing runs or writes once the session lock is released.
        await session?.abort().catch(() => {});
      }
      await flushPendingToolResultsAfterIdle({
        agent: session?.agent,
        sessionManager,
      });
      session?.dispose();
      await sessionLock.release();
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}
