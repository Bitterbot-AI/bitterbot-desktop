/**
 * The "pi" engine: pi-coding-agent's session, created and patched the way the
 * embedded runner needs it. Everything that touches pi's session API lives
 * here, so the runner itself does not import pi-coding-agent.
 *
 * Deleted one release after the default engine flips (PLAN-52 6.8).
 */

import {
  type AgentSession,
  createAgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AuthStorage, ModelRegistry } from "../../models/index.js";
import type { TranscriptStore } from "../../transcript/store.js";
import {
  createGuardedPiResourceLoader,
  createGuardedPiSettingsManager,
} from "./guarded-resources.js";
import { ensurePiCompactionReserveTokens } from "./settings.js";
import { applyToolLoopCompat } from "./tool-loop-compat.js";

/** The session type the embedded runner and its subscriber are written against. */
export type EmbeddedAgentSession = AgentSession;

type PiSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

/**
 * Replace pi's generated system prompt with ours. pi resets the prompt from
 * `_baseSystemPrompt` on every prompt() and rebuilds it on tool changes, so
 * all three places are set.
 */
export function applySystemPromptOverrideToSession(
  session: AgentSession,
  override: string | ((defaultPrompt?: string) => string),
): void {
  const prompt = typeof override === "function" ? override() : override.trim();
  session.agent.state.systemPrompt = prompt;
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}

export async function createPiSession(params: {
  /** Workspace the session runs in. */
  cwd: string;
  /** Unused since the workspace guard: pi no longer reads project settings. */
  settingsCwd: string;
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: PiSessionOptions["model"];
  thinkingLevel: PiSessionOptions["thinkingLevel"];
  /** Our tools as pi tool definitions, in the order sent to the model. */
  customTools: ToolDefinition[];
  store: TranscriptStore;
  systemPrompt: string;
  /** Floor for pi's compaction reserve (pi resets it while creating the session). */
  minReserveTokens: number;
  /** Sequential tools and steering skip, as the runner expects (not needed for compaction-only sessions). */
  toolLoopCompat: boolean;
}): Promise<AgentSession> {
  // Global settings only, and no pi resource discovery: the workspace is
  // agent-writable, so nothing under <workspace>/.pi may be loaded.
  const settingsManager = createGuardedPiSettingsManager(params.agentDir);
  const resourceLoader = await createGuardedPiResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager,
  });
  const { session } = await createAgentSession({
    cwd: params.cwd,
    agentDir: params.agentDir,
    // The owned registry, auth storage and transcript store have the methods
    // pi's session calls; the types differ only in pi's private fields.
    authStorage: params.authStorage as unknown as PiSessionOptions["authStorage"],
    modelRegistry: params.modelRegistry as unknown as PiSessionOptions["modelRegistry"],
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    // pi's `tools` is a name allowlist over built-in and custom tools; pass
    // exactly our names so the session gets our toolset and nothing else.
    tools: params.customTools.map((tool) => tool.name),
    customTools: params.customTools,
    sessionManager: params.store as unknown as PiSessionOptions["sessionManager"],
    settingsManager,
    resourceLoader,
  });
  applySystemPromptOverrideToSession(session, params.systemPrompt);
  // After createAgentSession: pi >= 0.73 reloads settings from disk while
  // creating the session, which drops overrides applied earlier.
  ensurePiCompactionReserveTokens({ settingsManager, minReserveTokens: params.minReserveTokens });
  if (params.toolLoopCompat) {
    applyToolLoopCompat(session);
  }
  return session;
}
