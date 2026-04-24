import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.bitterbot.ai/cli/skills")}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsList(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillInfo(report, name, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsCheck(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const importCmd = skills
    .command("import")
    .description("Import a skill from an external registry");

  importCmd
    .command("agentskills")
    .description("Import a skill from agentskills.io (by slug or https URL)")
    .argument("<input>", "Slug (e.g. 'github-release') or full https URL to a SKILL.md")
    .option("--accept", "Accept immediately without quarantine review", false)
    .option("--json", "Output as JSON", false)
    .action(async (input, opts) => {
      try {
        const { importAgentskillsSkill } = await import("../agents/skills/agentskills-ingest.js");
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        // Per-invocation override of defaultTrust when --accept is passed.
        const scopedConfig = opts.accept
          ? {
              ...config,
              skills: {
                ...config.skills,
                agentskills: {
                  ...config.skills?.agentskills,
                  enabled: true,
                  defaultTrust: "auto" as const,
                },
              },
            }
          : config;
        const result = await importAgentskillsSkill({
          input,
          config: scopedConfig,
          workspaceDir,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          const where = result.action === "accepted" ? "installed" : "quarantined for review";
          defaultRuntime.log(
            `${theme.muted("agentskills:")} ${result.skillName ?? "?"} ${where}\n` +
              `  source: ${result.resolvedUrl ?? "?"}\n` +
              (result.action === "quarantined"
                ? `  run: bitterbot skills incoming accept ${result.skillName}\n`
                : ""),
          );
        } else {
          defaultRuntime.error(`agentskills import failed: ${result.reason ?? "unknown"}`);
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const incoming = skills
    .command("incoming")
    .description("Review quarantined skills (P2P and imported)");

  incoming
    .command("list")
    .description("List quarantined skills awaiting review")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const { listIncomingSkills } = await import("../agents/skills/ingest.js");
        const config = loadConfig();
        const items = await listIncomingSkills(config);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(items, null, 2));
          return;
        }
        if (items.length === 0) {
          defaultRuntime.log(theme.muted("No skills in quarantine."));
          return;
        }
        for (const item of items) {
          const from = item.author_peer_id ?? "unknown";
          const when = item.timestamp ? new Date(item.timestamp).toISOString() : "";
          defaultRuntime.log(
            `  ${item.name}  ${theme.muted(`(from ${from}${when ? ` at ${when}` : ""})`)}`,
          );
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  incoming
    .command("accept")
    .description("Accept a quarantined skill into the active set")
    .argument("<name>", "Skill name as shown by 'skills incoming list'")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const { acceptIncomingSkill } = await import("../agents/skills/ingest.js");
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const result = await acceptIncomingSkill({ skillName: name, config, workspaceDir });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          defaultRuntime.log(`accepted: ${result.skillName}`);
        } else {
          defaultRuntime.error(`accept failed: ${result.reason ?? "unknown"}`);
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  incoming
    .command("reject")
    .description("Reject and delete a quarantined skill")
    .argument("<name>", "Skill name as shown by 'skills incoming list'")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const { rejectIncomingSkill } = await import("../agents/skills/ingest.js");
        const config = loadConfig();
        const result = await rejectIncomingSkill({ skillName: name, config });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          defaultRuntime.log(`rejected: ${name}`);
        } else {
          defaultRuntime.error(`reject failed: ${result.reason ?? "unknown"}`);
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    try {
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
      const report = buildWorkspaceSkillStatus(workspaceDir, { config });
      defaultRuntime.log(formatSkillsList(report, {}));
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
}
