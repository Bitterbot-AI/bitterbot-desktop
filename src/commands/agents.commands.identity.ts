import path from "node:path";
import type { IdentityConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries } from "./agents.config.js";

type AgentsSetIdentityOptions = {
  agent?: string;
  workspace?: string;
  name?: string;
  emoji?: string;
  theme?: string;
  avatar?: string;
  json?: boolean;
};

const normalizeWorkspacePath = (input: string) => path.resolve(resolveUserPath(input));

const coerceTrimmed = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function resolveAgentIdByWorkspace(
  cfg: Parameters<typeof resolveAgentWorkspaceDir>[0],
  workspaceDir: string,
): string[] {
  const list = listAgentEntries(cfg);
  const ids =
    list.length > 0
      ? list.map((entry) => normalizeAgentId(entry.id))
      : [resolveDefaultAgentId(cfg)];
  const normalizedTarget = normalizeWorkspacePath(workspaceDir);
  return ids.filter(
    (id) => normalizeWorkspacePath(resolveAgentWorkspaceDir(cfg, id)) === normalizedTarget,
  );
}

export async function agentsSetIdentityCommand(
  opts: AgentsSetIdentityOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const agentRaw = coerceTrimmed(opts.agent);
  const nameRaw = coerceTrimmed(opts.name);
  const emojiRaw = coerceTrimmed(opts.emoji);
  const themeRaw = coerceTrimmed(opts.theme);
  const avatarRaw = coerceTrimmed(opts.avatar);

  const workspaceRaw = coerceTrimmed(opts.workspace);
  let workspaceDir: string | undefined;

  if (workspaceRaw) {
    workspaceDir = normalizeWorkspacePath(workspaceRaw);
  } else if (!agentRaw) {
    workspaceDir = path.resolve(process.cwd());
  }

  let agentId = agentRaw ? normalizeAgentId(agentRaw) : undefined;
  if (!agentId) {
    if (!workspaceDir) {
      runtime.error("Select an agent with --agent or provide a workspace via --workspace.");
      runtime.exit(1);
      return;
    }
    const matches = resolveAgentIdByWorkspace(cfg, workspaceDir);
    if (matches.length === 0) {
      runtime.error(
        `No agent workspace matches ${shortenHomePath(workspaceDir)}. Pass --agent to target a specific agent.`,
      );
      runtime.exit(1);
      return;
    }
    if (matches.length > 1) {
      runtime.error(
        `Multiple agents match ${shortenHomePath(workspaceDir)}: ${matches.join(", ")}. Pass --agent to choose one.`,
      );
      runtime.exit(1);
      return;
    }
    agentId = matches[0];
  }

  const incomingIdentity: IdentityConfig = {
    ...(nameRaw ? { name: nameRaw } : {}),
    ...(emojiRaw ? { emoji: emojiRaw } : {}),
    ...(themeRaw ? { theme: themeRaw } : {}),
    ...(avatarRaw ? { avatar: avatarRaw } : {}),
  };

  if (
    !incomingIdentity.name &&
    !incomingIdentity.emoji &&
    !incomingIdentity.theme &&
    !incomingIdentity.avatar
  ) {
    runtime.error("No identity fields provided. Use --name/--emoji/--theme/--avatar.");
    runtime.exit(1);
    return;
  }

  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, agentId);
  const base = index >= 0 ? list[index] : { id: agentId };
  const nextIdentity: IdentityConfig = {
    ...base.identity,
    ...incomingIdentity,
  };

  const nextEntry = {
    ...base,
    identity: nextIdentity,
  };

  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
    if (nextList.length === 0 && agentId !== defaultId) {
      nextList.push({ id: defaultId });
    }
    nextList.push(nextEntry);
  }

  const nextConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: nextList,
    },
  };

  await writeConfigFile(nextConfig);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          identity: nextIdentity,
          workspace: workspaceDir ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  logConfigUpdated(runtime);
  runtime.log(`Agent: ${agentId}`);
  if (nextIdentity.name) {
    runtime.log(`Name: ${nextIdentity.name}`);
  }
  if (nextIdentity.theme) {
    runtime.log(`Theme: ${nextIdentity.theme}`);
  }
  if (nextIdentity.emoji) {
    runtime.log(`Emoji: ${nextIdentity.emoji}`);
  }
  if (nextIdentity.avatar) {
    runtime.log(`Avatar: ${nextIdentity.avatar}`);
  }
  if (workspaceDir) {
    runtime.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
  }
}
