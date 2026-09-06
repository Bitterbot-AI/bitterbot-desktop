import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
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
          // PLAN-44 Phase 5b: why the skill would or would not route here.
          if (item.routing?.summary) {
            defaultRuntime.log(
              `      ${item.routing.hold ? theme.warn("held for review: ") : theme.muted("note: ")}${theme.muted(item.routing.summary)}`,
            );
          }
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  addGatewayClientOptions(
    incoming
      .command("accept")
      .description("Accept a quarantined skill into the active set")
      .argument("<name>", "Skill name as shown by 'skills incoming list'")
      .option("--json", "Output as JSON", false),
  ).action(async (name, opts) => {
    try {
      // PLAN-44 Phase 3: prefer the gateway RPC — the running gateway is
      // what routes an accepted envelope into the skill-network bridge.
      // Fall back to the direct filesystem accept when no gateway is up.
      let result: { ok: boolean; skillName?: string; reason?: string; bridge?: string };
      try {
        result = (await callGatewayFromCli("skills.incoming.accept", opts, {
          skillName: name,
        })) as typeof result;
      } catch {
        const { acceptIncomingSkill } = await import("../agents/skills/ingest.js");
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        result = await acceptIncomingSkill({ skillName: name, config, workspaceDir });
        if (result.ok) {
          defaultRuntime.error(
            "note: gateway unreachable; accepted on disk only (no memory chunk until re-ingested)",
          );
        }
      }
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

  // PLAN-44 Phase 2: review the corpus miner's drafts (the only way a
  // capability task enters the live corpus). Goes through the gateway so
  // the running node's files are the ones edited.
  // PLAN-44 Phase 5c: rewrite non-routable harvested / received descriptions now.
  const routing = skills
    .command("routing")
    .description("Make live skills routable: rewrite descriptions the agent could never open");
  addGatewayClientOptions(
    routing
      .command("repair")
      .description("Rewrite non-routable live descriptions to the contract (dry-run lists them)")
      .option("--dry-run", "List candidates without rewriting", false)
      .option("--max <n>", "Max rewrites this run (default 5)")
      .option("--name <skill>", "Rewrite one skill only")
      .option("--json", "Output as JSON", false),
  ).action(async (opts) => {
    try {
      const result = (await callGatewayFromCli("skills.evolution.routing.repair", opts, {
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.max ? { max: Number(opts.max) } : {}),
        ...(opts.name ? { name: String(opts.name) } : {}),
      })) as {
        candidates?: Array<{ name: string; description: string; issues: string[] }>;
        outcomes?: Array<{
          name: string;
          outcome: string;
          from: string;
          to?: string;
          reason: string;
        }>;
      };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const c of result.candidates ?? []) {
        defaultRuntime.log(
          `  ${c.name}  ${theme.muted(`"${c.description.slice(0, 80)}"`)}\n      ${theme.warn(c.issues.join(", "))}`,
        );
      }
      for (const o of result.outcomes ?? []) {
        defaultRuntime.log(
          `  ${o.name}  ${o.outcome === "rewritten" ? theme.success("rewritten") : theme.warn(o.outcome)}${o.to ? `\n      → ${o.to}` : ""}${o.outcome !== "rewritten" ? `\n      ${theme.muted(o.reason)}` : ""}`,
        );
      }
      if (!result.candidates?.length && !result.outcomes?.length) {
        defaultRuntime.log(theme.muted("Every live skill already routes."));
      }
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  const corpus = skills
    .command("corpus")
    .description("Review mined capability-task drafts for skill-evolution validation");

  addGatewayClientOptions(
    corpus
      .command("list")
      .description("List pending drafts with review flags")
      .option("--json", "Output as JSON", false),
  ).action(async (opts) => {
    try {
      const result = (await callGatewayFromCli("skills.evolution.corpus.list", opts, {})) as {
        drafts: Array<{
          id: string;
          prompt: string;
          checker: { kind: string; value: string };
          flags: string[];
          acceptable: boolean;
        }>;
        liveCapabilityTasks: number;
        tasksModeThreshold: number;
      };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      defaultRuntime.log(
        `live capability tasks: ${result.liveCapabilityTasks} (tasks mode at ${result.tasksModeThreshold})`,
      );
      if (result.drafts.length === 0) {
        defaultRuntime.log(theme.muted("No pending drafts."));
        return;
      }
      for (const d of result.drafts) {
        const mark = d.acceptable ? "ok " : "!! ";
        defaultRuntime.log(
          `${mark}${d.id}${d.flags.length ? theme.muted(`  [${d.flags.join(", ")}]`) : ""}`,
        );
        defaultRuntime.log(`    ${d.prompt.replace(/\s+/g, " ").slice(0, 160)}`);
        defaultRuntime.log(theme.muted(`    ${d.checker.kind}: ${d.checker.value.slice(0, 80)}`));
      }
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    corpus
      .command("accept")
      .description("Promote reviewed drafts into the live capability suite")
      .argument("<ids...>", "Draft ids as shown by 'skills corpus list'")
      .option("--reviewed-by <name>", "Reviewer stamp", "operator")
      .option("--json", "Output as JSON", false),
  ).action(async (ids: string[], opts) => {
    try {
      const result = (await callGatewayFromCli("skills.evolution.corpus.accept", opts, {
        ids,
        reviewedBy: opts.reviewedBy,
      })) as {
        accepted: string[];
        refused: Array<{ id: string; reason: string }>;
        liveTaskCount: number;
      };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const id of result.accepted) {
        defaultRuntime.log(`accepted: ${id}`);
      }
      for (const r of result.refused) {
        defaultRuntime.error(`refused: ${r.id} (${r.reason})`);
      }
      defaultRuntime.log(`live corpus: ${result.liveTaskCount} task(s)`);
      if (result.refused.length > 0 && result.accepted.length === 0) {
        defaultRuntime.exit(1);
      }
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    skills
      .command("feedback")
      .description(
        "Record a human verdict on one run (level-4 outcome evidence for the learning loop)",
      )
      .argument("<runId>", "Run id (from the journal / task_monitor / session status)")
      .argument("<verdict>", "confirmed | rejected")
      .option("--note <text>", "Why (recorded, capped at 500 chars)")
      .option("--by <name>", "Who is recording it", "operator")
      .option("--json", "Output as JSON", false),
  ).action(async (runId: string, verdict: string, opts) => {
    if (verdict !== "confirmed" && verdict !== "rejected") {
      defaultRuntime.error("verdict must be confirmed or rejected");
      defaultRuntime.exit(1);
      return;
    }
    try {
      const result = await callGatewayFromCli("skills.evolution.feedback", opts, {
        runId,
        verdict,
        ...(opts.note ? { note: opts.note } : {}),
        by: opts.by,
      });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      defaultRuntime.log(`recorded: run ${runId} ${verdict}`);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  // PLAN-45 Phase 1.5: blind labeler calibration on real traces.
  const calibrate = skills
    .command("calibrate")
    .description("Calibrate the trace labeler against human labels on real runs");
  addGatewayClientOptions(
    calibrate
      .command("export")
      .description(
        "Write a blind set of real traces (blind.jsonl) plus the labeler's hidden key (key.jsonl)",
      )
      .option("--count <n>", "Traces to export (1-500)", "100")
      .option("--seed <seed>", "Deterministic selection seed")
      .option("--with-judge", "Also record the LLM judge's label (two calls per trace)", false)
      .option("--json", "Output as JSON", false),
  ).action(async (opts) => {
    try {
      const result = (await callGatewayFromCli("skills.evolution.calibration.export", opts, {
        count: Number.parseInt(String(opts.count), 10),
        ...(opts.seed ? { seed: String(opts.seed) } : {}),
        withJudge: Boolean(opts.withJudge),
      })) as { dir: string; count: number; stats: Record<string, unknown> };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      defaultRuntime.log(`wrote ${result.count} traces to ${result.dir}`);
      defaultRuntime.log(
        theme.muted("label blind.jsonl without opening key.jsonl; see README.md in that directory"),
      );
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
  addGatewayClientOptions(
    calibrate
      .command("score")
      .description("Score one or two human label files against the labeler's key")
      .argument("<dir>", "Calibration set directory (from 'skills calibrate export')")
      .requiredOption("--labels <file...>", "Label file(s), one or two")
      .option("--json", "Output as JSON", false),
  ).action(async (dir: string, opts) => {
    try {
      const labels = (Array.isArray(opts.labels) ? opts.labels : [opts.labels]).map(String);
      const result = (await callGatewayFromCli("skills.evolution.calibration.score", opts, {
        dir,
        labels: labels.slice(0, 2),
      })) as { report: unknown; text: string };
      defaultRuntime.log(opts.json ? JSON.stringify(result.report, null, 2) : result.text);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    corpus
      .command("reject")
      .description("Drop drafts; the miner never redrafts a rejected id")
      .argument("<ids...>", "Draft ids as shown by 'skills corpus list'")
      .option("--reviewed-by <name>", "Reviewer stamp", "operator")
      .option("--reason <text>", "Why (recorded)")
      .option("--json", "Output as JSON", false),
  ).action(async (ids: string[], opts) => {
    try {
      const result = (await callGatewayFromCli("skills.evolution.corpus.reject", opts, {
        ids,
        reviewedBy: opts.reviewedBy,
        ...(opts.reason ? { reason: opts.reason } : {}),
      })) as { rejected: string[]; missing: string[] };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const id of result.rejected) {
        defaultRuntime.log(`rejected: ${id}`);
      }
      for (const id of result.missing) {
        defaultRuntime.error(`not pending: ${id}`);
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
