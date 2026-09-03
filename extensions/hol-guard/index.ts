import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_EXECUTABLE = "hol-guard";
const DEFAULT_TIMEOUT_MS = 10_000;

type HolGuardPluginConfig = {
  executable?: string;
  timeoutMs?: number;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

type BeforeToolCallResult = {
  block?: boolean;
  blockReason?: string;
};

export type GuardInspector = (command: string) => Promise<boolean>;

function resolvePluginConfig(pluginConfig?: Record<string, unknown>) {
  const cfg = (pluginConfig ?? {}) as HolGuardPluginConfig;
  const executable =
    typeof cfg.executable === "string" && cfg.executable.trim()
      ? cfg.executable.trim()
      : DEFAULT_EXECUTABLE;
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs)
      ? Math.max(100, Math.min(30_000, Math.trunc(cfg.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
  return { executable, timeoutMs };
}

async function inspectCommandWithHolGuard(
  command: string,
  options: { executable: string; timeoutMs: number },
): Promise<boolean> {
  const { stdout } = await execFileAsync(
    options.executable,
    ["command", "test", command, "--json"],
    {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout) as {
    classification?: { explicitly_benign?: boolean };
    minimum_action?: string;
  };
  return result.classification?.explicitly_benign === true && result.minimum_action === "allow";
}

export function createHolGuardBeforeToolCallHandler(inspect: GuardInspector) {
  return async (event: BeforeToolCallEvent): Promise<BeforeToolCallResult | void> => {
    if (event.toolName !== "exec") {
      return;
    }

    const command = event.params.command;
    if (typeof command !== "string" || !command.trim()) {
      return {
        block: true,
        blockReason: "HOL Guard: exec command text is missing or invalid.",
      };
    }

    try {
      if (await inspect(command)) {
        return;
      }
      return {
        block: true,
        blockReason: "HOL Guard: command requires review before execution.",
      };
    } catch (err) {
      // Fail closed either way, but tell the operator WHY: the most common
      // cause is enabling the plugin without installing the CLI.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOENT") {
        return {
          block: true,
          blockReason:
            "HOL Guard: CLI not found. Install it with `pipx install hol-guard` and run `hol-guard init`, or disable the hol-guard plugin.",
        };
      }
      return {
        block: true,
        blockReason: "HOL Guard: command inspection failed.",
      };
    }
  };
}

const holGuardPlugin = {
  id: "hol-guard",
  name: "HOL Guard",
  description:
    "Run HOL Guard before Bitterbot shell commands execute (requires `pipx install hol-guard`; fails closed when the CLI is missing).",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      executable: {
        type: "string",
        default: DEFAULT_EXECUTABLE,
      },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 30_000,
        default: DEFAULT_TIMEOUT_MS,
      },
    },
  },
  register(api: BitterbotPluginApi) {
    const config = resolvePluginConfig(api.pluginConfig);
    api.on(
      "before_tool_call",
      createHolGuardBeforeToolCallHandler((command) => inspectCommandWithHolGuard(command, config)),
    );
  },
};

export default holGuardPlugin;
