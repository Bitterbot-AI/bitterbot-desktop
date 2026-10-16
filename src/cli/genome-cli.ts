import type { Command } from "commander";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  addTemperament,
  readTemperamentStatus,
  setTemperamentLevel,
  type TemperamentStatus,
  type TemperamentWriteResult,
} from "../agents/genome-temperament.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import {
  DEFAULT_TEMPERAMENT_LEVEL,
  isTemperamentLevel,
  TEMPERAMENT_LEVELS,
  type TemperamentLevel,
} from "../memory/genome-parser.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { promptYesNo } from "./prompt.js";

// GENOME.md's Temperament section from the terminal: see it, add it to an
// agent created before it existed, change its level. Same writes as the
// Control UI card (genome.temperament.* RPCs): only that section is touched,
// the previous Genome is backed up, and the agent itself can never do this.

type TemperamentOpts = {
  agent?: string;
  add?: boolean;
  level?: string;
  yes?: boolean;
  json?: boolean;
};

function fail(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function resolveTarget(agent?: string): { agentId: string; workspaceDir: string } {
  const cfg = loadConfig();
  const raw = agent?.trim();
  const agentId = raw ? normalizeAgentId(raw) : resolveDefaultAgentId(cfg);
  if (raw && !listAgentIds(cfg).includes(agentId)) {
    fail(`Unknown agent "${raw}". See \`bitterbot agents list\`.`);
  }
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) };
}

/**
 * The write goes through the running gateway when there is one, so its genome
 * guard knows the new content is the owner's (a tool call in flight keeps
 * it). With no gateway running there is nothing to race, and it is written
 * here with the same backup.
 */
async function writeViaGatewayOrLocal(
  agentId: string,
  params: { action: "add" | "setLevel"; level?: TemperamentLevel },
  local: () => Promise<TemperamentWriteResult>,
): Promise<TemperamentWriteResult> {
  // A remote gateway has its own workspace: this command edits the local one.
  if (loadConfig().gateway?.mode === "remote") {
    return await local();
  }
  try {
    return await callGateway<TemperamentWriteResult>({
      method: "genome.temperament.apply",
      params: { agentId, ...params },
      timeoutMs: 10_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/^gateway (closed|timeout)|unknown method/i.test(message)) {
      return await local();
    }
    throw err;
  }
}

export function formatTemperamentStatus(status: TemperamentStatus): string {
  const where = shortenHomePath(status.genomePath);
  if (!status.genomeExists) {
    return `${theme.heading("Temperament")}: no GENOME.md at ${where}. Run \`bitterbot setup\` first.`;
  }
  if (status.present) {
    return [
      `${theme.heading("Temperament")}: ${status.level} (${where})`,
      `Change it with \`bitterbot genome temperament --level ${TEMPERAMENT_LEVELS.join("|")}\`.`,
      "",
      status.preview,
    ].join("\n");
  }
  return [
    `${theme.heading("Temperament")}: not in ${where} yet.`,
    "A base personality is available for your agent. This is what would be added (nothing else in GENOME.md changes):",
    "",
    status.preview,
    "",
    `Add it with \`bitterbot genome temperament --add\` (optionally \`--level ${TEMPERAMENT_LEVELS.join("|")}\`).`,
  ].join("\n");
}

async function confirmWrite(question: string, opts: TemperamentOpts): Promise<boolean> {
  if (opts.yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    fail("Not a terminal: pass --yes to confirm the change.");
  }
  return await promptYesNo(question, true);
}

export async function runGenomeTemperament(opts: TemperamentOpts): Promise<void> {
  const level = opts.level?.trim().toLowerCase();
  if (level !== undefined && !isTemperamentLevel(level)) {
    fail(`--level must be one of ${TEMPERAMENT_LEVELS.join(", ")}.`);
  }
  const { agentId, workspaceDir } = resolveTarget(opts.agent);
  const status = await readTemperamentStatus(workspaceDir, {
    previewLevel: level ?? DEFAULT_TEMPERAMENT_LEVEL,
  });

  if (!opts.add && level === undefined) {
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(status, null, 2));
      return;
    }
    defaultRuntime.log(formatTemperamentStatus(status));
    return;
  }
  if (!status.genomeExists) {
    fail(formatTemperamentStatus(status));
  }

  let result: TemperamentWriteResult;
  if (opts.add && !status.present) {
    const chosen = level ?? DEFAULT_TEMPERAMENT_LEVEL;
    if (!opts.json) {
      defaultRuntime.log(formatTemperamentStatus(status));
    }
    if (!(await confirmWrite(`Add this Temperament (${chosen}) to GENOME.md?`, opts))) {
      defaultRuntime.log("Nothing changed.");
      return;
    }
    result = await writeViaGatewayOrLocal(agentId, { action: "add", level: chosen }, () =>
      addTemperament(workspaceDir, chosen),
    );
  } else if (!status.present) {
    fail(
      "GENOME.md has no Temperament section yet. Add it with `bitterbot genome temperament --add`.",
    );
  } else if (level === undefined || level === status.level) {
    result = { status, changed: false };
  } else {
    if (!(await confirmWrite(`Change the Temperament from ${status.level} to ${level}?`, opts))) {
      defaultRuntime.log("Nothing changed.");
      return;
    }
    result = await writeViaGatewayOrLocal(agentId, { action: "setLevel", level }, () =>
      setTemperamentLevel(workspaceDir, level),
    );
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.changed) {
    defaultRuntime.log(
      `Temperament is already ${result.status.level ?? "set"}; GENOME.md was not changed.`,
    );
    return;
  }
  defaultRuntime.log(
    [
      `Temperament: ${result.status.level}. It applies from the agent's next turn.`,
      result.backupPath ? `Previous GENOME.md kept at ${shortenHomePath(result.backupPath)}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function registerGenomeCli(program: Command) {
  const genome = program
    .command("genome")
    .description("Your agent's GENOME.md (safety axioms, values, temperament)");

  genome
    .command("temperament")
    .description(
      "Show the agent's base personality (GENOME.md Temperament), add it to an existing agent, or change its level",
    )
    .option("--agent <id>", "Agent id (default: the default agent)")
    .option("--add", "Add the Temperament section to GENOME.md (no other section changes)")
    .option("--level <level>", `Starting voice: ${TEMPERAMENT_LEVELS.join(" | ")}`)
    .option("-y, --yes", "Do not ask for confirmation")
    .option("--json", "Output JSON")
    .action(async (opts: TemperamentOpts) => {
      try {
        await runGenomeTemperament(opts);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
