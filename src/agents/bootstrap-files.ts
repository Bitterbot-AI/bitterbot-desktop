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
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

/** Token-efficiency W4: working-memory files are capped before injection. */
export const WORKING_MEMORY_MAX_LINES = 200;
export const WORKING_MEMORY_MAX_CHARS = 25_000;
/** Constant marker: no counts or sizes, so the injected text never churns on the marker. */
export const WORKING_MEMORY_TRUNCATED_LINE = "(truncated, use memory tools)";

/**
 * Cap MEMORY.md / memory/scratch.md at 200 lines and 25 KB with a stable
 * marker line. The deeper adaptive budget in pi-embedded-helpers/bootstrap
 * still applies after this; this cap bounds what can ever reach the prompt.
 */
export function capWorkingMemoryContent(content: string): string {
  let text = content.replace(/\r\n?/g, "\n");
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > WORKING_MEMORY_MAX_LINES) {
    text = lines.slice(0, WORKING_MEMORY_MAX_LINES).join("\n");
    truncated = true;
  }
  if (text.length > WORKING_MEMORY_MAX_CHARS) {
    text = text.slice(0, WORKING_MEMORY_MAX_CHARS);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > WORKING_MEMORY_MAX_CHARS * 0.5) {
      text = text.slice(0, lastNewline);
    }
    truncated = true;
  }
  return truncated ? `${text.trimEnd()}\n\n${WORKING_MEMORY_TRUNCATED_LINE}` : content;
}

/**
 * Files that reach the injected Project Context. HEARTBEAT.md is injected
 * only on heartbeat runs (the heartbeat prompt tells the agent to read it
 * otherwise); working-memory files are capped.
 */
export function selectContextInjectionFiles(
  files: WorkspaceBootstrapFile[],
  opts: { includeHeartbeatFile?: boolean },
): WorkspaceBootstrapFile[] {
  const out: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    if (file.name === DEFAULT_HEARTBEAT_FILENAME && !opts.includeHeartbeatFile) {
      continue;
    }
    if (
      file.name === DEFAULT_MEMORY_FILENAME &&
      !file.missing &&
      typeof file.content === "string"
    ) {
      out.push({ ...file, content: capWorkingMemoryContent(file.content) });
      continue;
    }
    out.push(file);
  }
  return out;
}

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
  /**
   * Inject HEARTBEAT.md into the prompt. Defaults to false; the runner sets
   * it for heartbeat runs (`isHeartbeat`). Every other turn reads the file
   * on demand, which keeps the periodic task list out of the cached prefix.
   */
  includeHeartbeatFile?: boolean;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const injectionFiles = selectContextInjectionFiles(bootstrapFiles, {
    includeHeartbeatFile: params.includeHeartbeatFile === true,
  });
  const contextFiles = buildBootstrapContextFiles(injectionFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
