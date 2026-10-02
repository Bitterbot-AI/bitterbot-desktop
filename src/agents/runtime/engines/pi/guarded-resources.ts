/**
 * Guarded pi resources: settings and a resource loader that take nothing from
 * the agent's workspace.
 *
 * pi-coding-agent is a coding CLI, so by default it treats the working
 * directory as a trusted project: `createAgentSession` without a
 * `resourceLoader` discovers and imports every `.ts`/`.js` under
 * `<cwd>/.pi/extensions` and `<agentDir>/extensions`, reads
 * `<cwd>/.pi/settings.json` (which can name more extensions and packages), and
 * picks up skills, prompt templates, and SYSTEM.md / AGENTS.md files from the
 * same places. In Bitterbot the cwd is the agent's own workspace, which the
 * agent's file tools write to, so those defaults would let workspace content
 * run inside the gateway process.
 *
 * Bitterbot uses none of these pi features: the system prompt is replaced
 * wholesale, skills are Bitterbot's own, and tools arrive as `customTools`.
 * This module therefore turns all of them off rather than filtering them.
 */

import fs from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent";

type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/**
 * Settings storage with a global scope only (`<agentDir>/settings.json`). The
 * project scope, which pi maps to `<cwd>/.pi/settings.json`, reads as absent
 * and drops writes.
 */
export function createGlobalOnlySettingsStorage(agentDir: string): PiSettingsStorage {
  const settingsPath = path.join(agentDir, "settings.json");
  return {
    withLock(scope, fn) {
      if (scope !== "global") {
        fn(undefined);
        return;
      }
      let current: string | undefined;
      try {
        current = fs.readFileSync(settingsPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      const next = fn(current);
      if (next !== undefined) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const tmp = `${settingsPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, next, "utf-8");
        fs.renameSync(tmp, settingsPath);
      }
    },
  };
}

/** A SettingsManager that never reads or writes the workspace. */
export function createGuardedPiSettingsManager(agentDir: string): SettingsManager {
  return SettingsManager.fromStorage(createGlobalOnlySettingsStorage(agentDir));
}

/**
 * A resource loader with extension, skill, prompt-template, theme, and
 * context-file discovery off, already reloaded. Pass it to
 * `createAgentSession({ resourceLoader })`; without it pi builds its default
 * loader and imports workspace extensions.
 */
export async function createGuardedPiResourceLoader(params: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager: params.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}
