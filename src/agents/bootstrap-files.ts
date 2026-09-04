import type { BitterbotConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { isSkillEvolveValidationSessionKey } from "../sessions/session-key-utils.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: BitterbotConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  if (isSkillEvolveValidationSessionKey(sessionKey)) {
    // PLAN-44 Phase 3: a skill-evolution validation rollout (own candidate
    // or peer attestation) is hermetic. Its scratch workspace carries no
    // bootstrap files by design, so loading them only yields a wall of
    // "[MISSING] Expected at: ..." lines that the model then narrates
    // ("my PROTOCOLS.md is missing") instead of doing the task; and where
    // the workspace is real (peer sweep), GENOME/MEMORY/scratch are the
    // node's private state, which PLAN-43 s3.2b already withholds from
    // these sessions on every other channel. No files, no hook overrides.
    return [];
  }
  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );

  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: BitterbotConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
