import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceTemplateDir } from "../../agents/workspace-templates.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { handleReset } from "../../commands/onboard-helpers.js";
import { createConfigIO, writeConfigFile } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath, shortenHomePath } from "../../utils.js";

const DEV_AGENT_NAME = "C3-PO";
const DEV_AGENT_THEME = "protocol droid";
const DEV_AGENT_EMOJI = "🤖";
const DEV_AGENT_WORKSPACE_SUFFIX = "dev";

async function loadDevTemplate(name: string, fallback: string): Promise<string> {
  try {
    const templateDir = await resolveWorkspaceTemplateDir();
    const raw = await fs.promises.readFile(path.join(templateDir, name), "utf-8");
    if (!raw.startsWith("---")) {
      return raw;
    }
    const endIndex = raw.indexOf("\n---", 3);
    if (endIndex === -1) {
      return raw;
    }
    return raw.slice(endIndex + "\n---".length).replace(/^\s+/, "");
  } catch {
    return fallback;
  }
}

const resolveDevWorkspaceDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const baseDir = resolveDefaultAgentWorkspaceDir(env, os.homedir);
  const profile = env.BITTERBOT_PROFILE?.trim().toLowerCase();
  if (profile === "dev") {
    return baseDir;
  }
  return `${baseDir}-${DEV_AGENT_WORKSPACE_SUFFIX}`;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
  }
}

async function ensureDevWorkspace(dir: string) {
  const resolvedDir = resolveUserPath(dir);
  await fs.promises.mkdir(resolvedDir, { recursive: true });

  const tools = await loadDevTemplate(
    "TOOLS.dev.md",
    `# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n`,
  );

  await writeFileIfMissing(path.join(resolvedDir, "TOOLS.md"), tools);
}

export async function ensureDevGatewayConfig(opts: { reset?: boolean }) {
  const workspace = resolveDevWorkspaceDir();
  if (opts.reset) {
    await handleReset("full", workspace, defaultRuntime);
  }

  const io = createConfigIO();
  const configPath = io.configPath;
  const configExists = fs.existsSync(configPath);
  if (!opts.reset && configExists) {
    return;
  }

  await writeConfigFile({
    gateway: {
      mode: "local",
      bind: "loopback",
    },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
      },
      list: [
        {
          id: "dev",
          default: true,
          workspace,
          identity: {
            name: DEV_AGENT_NAME,
            theme: DEV_AGENT_THEME,
            emoji: DEV_AGENT_EMOJI,
          },
        },
      ],
    },
  });
  await ensureDevWorkspace(workspace);
  defaultRuntime.log(`Dev config ready: ${shortenHomePath(configPath)}`);
  defaultRuntime.log(`Dev workspace ready: ${shortenHomePath(resolveUserPath(workspace))}`);
}
