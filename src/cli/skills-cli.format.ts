import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

export type SkillsListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type SkillInfoOptions = {
  json?: boolean;
};

export type SkillsCheckOptions = {
  json?: boolean;
};

function appendClawHubHint(output: string, json?: boolean): string {
  if (json) {
    return output;
  }
  return `${output}\n\nTip: use \`bitterbot skills\` to search, install, and sync skills.`;
}

function formatSkillStatus(skill: SkillStatusEntry): string {
  if (skill.eligible) {
    return theme.success("✓ ready");
  }
  if (skill.disabled) {
    return theme.warn("⏸ disabled");
  }
  if (skill.blockedByAllowlist) {
    return theme.warn("🚫 blocked");
  }
  return theme.error("✗ missing");
}

function formatSkillName(skill: SkillStatusEntry): string {
  const emoji = skill.emoji ?? "📦";
  return `${emoji} ${theme.command(skill.name)}`;
}

function formatSkillMissingSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`anyBins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ");
}

export function formatSkillsList(report: SkillStatusReport, opts: SkillsListOptions): string {
  const skills = opts.eligible ? report.skills.filter((s) => s.eligible) : report.skills;

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedSkillsDir: report.managedSkillsDir,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        emoji: s.emoji,
        eligible: s.eligible,
        disabled: s.disabled,
        blockedByAllowlist: s.blockedByAllowlist,
        source: s.source,
        bundled: s.bundled,
        primaryEnv: s.primaryEnv,
        homepage: s.homepage,
        missing: s.missing,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (skills.length === 0) {
    const message = opts.eligible
      ? `No eligible skills found. Run \`${formatCliCommand("bitterbot skills list")}\` to see all skills.`
      : "No skills found.";
    return appendClawHubHint(message, opts.json);
  }

  const eligible = skills.filter((s) => s.eligible);
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = skills.map((skill) => {
    const missing = formatSkillMissingSummary(skill);
    return {
      Status: formatSkillStatus(skill),
      Skill: formatSkillName(skill),
      Description: theme.muted(skill.description),
      Source: skill.source ?? "",
      Missing: missing ? theme.warn(missing) : "",
    };
  });

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Skill", header: "Skill", minWidth: 18, flex: true },
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    { key: "Source", header: "Source", minWidth: 10 },
  ];
  if (opts.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }

  const lines: string[] = [];
  lines.push(
    `${theme.heading("Skills")} ${theme.muted(`(${eligible.length}/${skills.length} ready)`)}`,
  );
  lines.push(
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  );

  return appendClawHubHint(lines.join("\n"), opts.json);
}

export function formatSkillInfo(
  report: SkillStatusReport,
  skillName: string,
  opts: SkillInfoOptions,
): string {
  const skill = report.skills.find((s) => s.name === skillName || s.skillKey === skillName);

  if (!skill) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", skill: skillName }, null, 2);
    }
    return appendClawHubHint(
      `Skill "${skillName}" not found. Run \`${formatCliCommand("bitterbot skills list")}\` to see available skills.`,
      opts.json,
    );
  }

  if (opts.json) {
    return JSON.stringify(skill, null, 2);
  }

  const lines: string[] = [];
  const emoji = skill.emoji ?? "📦";
  const status = skill.eligible
    ? theme.success("✓ Ready")
    : skill.disabled
      ? theme.warn("⏸ Disabled")
      : skill.blockedByAllowlist
        ? theme.warn("🚫 Blocked by allowlist")
        : theme.error("✗ Missing requirements");

  lines.push(`${emoji} ${theme.heading(skill.name)} ${status}`);
  lines.push("");
  lines.push(skill.description);
  lines.push("");

  lines.push(theme.heading("Details:"));
  lines.push(`${theme.muted("  Source:")} ${skill.source}`);
  lines.push(`${theme.muted("  Path:")} ${shortenHomePath(skill.filePath)}`);
  if (skill.homepage) {
    lines.push(`${theme.muted("  Homepage:")} ${skill.homepage}`);
  }
  if (skill.primaryEnv) {
    lines.push(`${theme.muted("  Primary env:")} ${skill.primaryEnv}`);
  }

  const hasRequirements =
    skill.requirements.bins.length > 0 ||
    skill.requirements.anyBins.length > 0 ||
    skill.requirements.env.length > 0 ||
    skill.requirements.config.length > 0 ||
    skill.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(theme.heading("Requirements:"));
    if (skill.requirements.bins.length > 0) {
      const binsStatus = skill.requirements.bins.map((bin) => {
        const missing = skill.missing.bins.includes(bin);
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
    }
    if (skill.requirements.anyBins.length > 0) {
      const anyBinsMissing = skill.missing.anyBins.length > 0;
      const anyBinsStatus = skill.requirements.anyBins.map((bin) => {
        const missing = anyBinsMissing;
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Any binaries:")} ${anyBinsStatus.join(", ")}`);
    }
    if (skill.requirements.env.length > 0) {
      const envStatus = skill.requirements.env.map((env) => {
        const missing = skill.missing.env.includes(env);
        return missing ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
      });
      lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
    }
    if (skill.requirements.config.length > 0) {
      const configStatus = skill.requirements.config.map((cfg) => {
        const missing = skill.missing.config.includes(cfg);
        return missing ? theme.error(`✗ ${cfg}`) : theme.success(`✓ ${cfg}`);
      });
      lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
    }
    if (skill.requirements.os.length > 0) {
      const osStatus = skill.requirements.os.map((osName) => {
        const missing = skill.missing.os.includes(osName);
        return missing ? theme.error(`✗ ${osName}`) : theme.success(`✓ ${osName}`);
      });
      lines.push(`${theme.muted("  OS:")} ${osStatus.join(", ")}`);
    }
  }

  if (skill.install.length > 0 && !skill.eligible) {
    lines.push("");
    lines.push(theme.heading("Install options:"));
    for (const inst of skill.install) {
      lines.push(`  ${theme.warn("→")} ${inst.label}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}

export function formatSkillsCheck(report: SkillStatusReport, opts: SkillsCheckOptions): string {
  const eligible = report.skills.filter((s) => s.eligible);
  const disabled = report.skills.filter((s) => s.disabled);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
  const missingReqs = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
  );

  if (opts.json) {
    return JSON.stringify(
      {
        summary: {
          total: report.skills.length,
          eligible: eligible.length,
          disabled: disabled.length,
          blocked: blocked.length,
          missingRequirements: missingReqs.length,
        },
        eligible: eligible.map((s) => s.name),
        disabled: disabled.map((s) => s.name),
        blocked: blocked.map((s) => s.name),
        missingRequirements: missingReqs.map((s) => ({
          name: s.name,
          missing: s.missing,
          install: s.install,
        })),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(theme.heading("Skills Status Check"));
  lines.push("");
  lines.push(`${theme.muted("Total:")} ${report.skills.length}`);
  lines.push(`${theme.success("✓")} ${theme.muted("Eligible:")} ${eligible.length}`);
  lines.push(`${theme.warn("⏸")} ${theme.muted("Disabled:")} ${disabled.length}`);
  lines.push(`${theme.warn("🚫")} ${theme.muted("Blocked by allowlist:")} ${blocked.length}`);
  lines.push(`${theme.error("✗")} ${theme.muted("Missing requirements:")} ${missingReqs.length}`);

  if (eligible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Ready to use:"));
    for (const skill of eligible) {
      const emoji = skill.emoji ?? "📦";
      lines.push(`  ${emoji} ${skill.name}`);
    }
  }

  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(theme.heading("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = skill.emoji ?? "📦";
      const missing = formatSkillMissingSummary(skill);
      lines.push(`  ${emoji} ${skill.name} ${theme.muted(`(${missing})`)}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}

// ── PLAN-45 Phase 6: `bitterbot skills evidence [name]` ──────────────────

import type { SkillEvidenceRecord } from "../memory/skill-evolution/evidence-record.js";

export type SkillEvidenceOptions = { json: boolean; all?: boolean };

function pct(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v * 100)}%`;
}

function ago(ts: number | null, now = Date.now()): string {
  if (ts === null) {
    return "never";
  }
  const ms = Math.max(0, now - ts);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) {
    return `${Math.floor(ms / 60_000)}m ago`;
  }
  if (h < 48) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

function ladderLabel(ladder: SkillEvidenceRecord["ladder"]): string {
  switch (ladder) {
    case "stable":
      return theme.success(ladder);
    case "canary":
    case "validated":
    case "staged":
      return theme.warn(ladder);
    case "rolled-back":
    case "retired":
    case "canary-off":
      return theme.error(ladder);
    default:
      return theme.muted(ladder);
  }
}

/**
 * One skill: the evidence record as the operator should read it. Every
 * number comes from the record housekeeping rebuilt (nothing is recomputed
 * here), so the CLI, the Control UI card and the published evidence agree.
 */
export function formatSkillEvidence(
  records: SkillEvidenceRecord[],
  skillName: string | undefined,
  opts: SkillEvidenceOptions,
  now = Date.now(),
): string {
  if (!skillName) {
    const shown = opts.all ? records : records.filter((r) => r.ladder !== "unmanaged");
    if (opts.json) {
      return JSON.stringify(shown, null, 2);
    }
    if (shown.length === 0) {
      return records.length === 0
        ? "No evidence records yet (housekeeping writes .evidence.json per live skill after the first pass)."
        : "No evolved or received skill is live. `--all` lists every live skill's record.";
    }
    const lines = [theme.heading(`Skill evidence (${shown.length})`), ""];
    for (const r of shown) {
      const gate = r.gate?.verdict ? `gate ${r.gate.verdict}` : "no gate";
      lines.push(
        `  ${r.name.padEnd(28)} ${ladderLabel(r.ladder).padEnd(20)} ${gate.padEnd(14)} reads ${String(r.reads.total).padStart(3)} ok ${pct(r.reads.successRate).padStart(4)}  ${theme.muted(ago(r.reads.lastReadAt, now))}`,
      );
    }
    lines.push(
      "",
      theme.muted(
        `Run \`${formatCliCommand("bitterbot skills evidence <name>")}\` for one record.`,
      ),
    );
    return lines.join("\n");
  }
  const r = records.find((x) => x.name === skillName);
  if (!r) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", skill: skillName }, null, 2);
    }
    return `No evidence record for "${skillName}". It is written per LIVE skill by housekeeping; run \`${formatCliCommand("bitterbot skills evidence")}\` to list the ones present.`;
  }
  if (opts.json) {
    return JSON.stringify(r, null, 2);
  }
  const lines: string[] = [];
  lines.push(`${theme.heading(r.name)} ${ladderLabel(r.ladder)} ${theme.muted(`(${r.origin})`)}`);
  lines.push(
    theme.muted(
      `  record v${r.version}, generated ${ago(r.generatedAt, now)}, ${r.windowDays}-day window`,
    ),
  );
  lines.push("");
  lines.push(theme.heading("Ladder:"));
  lines.push(
    `${theme.muted("  State:")} ${r.ladder}${r.ladderAt ? ` since ${new Date(r.ladderAt).toISOString()}` : ""}${r.ladderBy ? ` by ${r.ladderBy}` : ""}`,
  );
  if (r.canary) {
    lines.push(
      `${theme.muted("  Canary:")} started ${ago(r.canary.startedAt, now)} (${r.canary.reason})${r.canary.endedAt ? `, ended ${ago(r.canary.endedAt, now)}` : ", running"}`,
    );
  }
  if (r.modelDrift) {
    lines.push(
      `${theme.muted("  Model drift:")} ${r.modelDrift.from} -> ${r.modelDrift.to} (${ago(r.modelDrift.at, now)})`,
    );
  }
  if (r.publishedAt) {
    lines.push(`${theme.muted("  Published:")} ${ago(r.publishedAt, now)}`);
  }
  lines.push("");
  lines.push(theme.heading("Gate:"));
  if (r.gate) {
    const g = r.gate;
    lines.push(
      `${theme.muted("  Verdict:")} ${g.verdict ?? "n/a"} (${g.mode ?? "?"} mode${g.pValue !== null ? `, p=${g.pValue.toFixed(3)}` : ""})`,
    );
    if (g.wins !== null || g.losses !== null) {
      lines.push(
        `${theme.muted("  Trials:")} ${g.wins ?? 0} wins / ${g.losses ?? 0} losses over ${g.trials ?? "?"} trials${g.trialsPerTask ? ` (${g.trialsPerTask} per task)` : ""}`,
      );
    }
    if (g.candidateReadRate) {
      lines.push(
        `${theme.muted("  Candidate read rate:")} capability ${pct(g.candidateReadRate.capability)}, regression ${pct(g.candidateReadRate.regression)}`,
      );
    }
    if (g.tokens) {
      lines.push(
        `${theme.muted("  Tokens:")} incumbent ${g.tokens.incumbent}, candidate ${g.tokens.candidate}`,
      );
    }
    if (g.corpusVersion) {
      lines.push(`${theme.muted("  Corpus:")} ${g.corpusVersion}`);
    }
    if (g.validatedAt) {
      lines.push(`${theme.muted("  Validated:")} ${ago(g.validatedAt, now)}`);
    }
  } else {
    lines.push(theme.muted("  none (not an evolved or re-gated skill)"));
  }
  lines.push("");
  lines.push(theme.heading("Production reads (window):"));
  lines.push(
    `${theme.muted("  Reads:")} ${r.reads.total} in ${r.reads.runs} runs; pass ${r.reads.pass}, fail ${r.reads.fail}, indeterminate ${r.reads.indeterminate}; success ${pct(r.reads.successRate)}; max evidence level L${r.reads.maxEvidenceLevel}; last ${ago(r.reads.lastReadAt, now)}`,
  );
  lines.push(
    `${theme.muted("  Lifetime:")} used ${r.lifetime.usageCount}, success ${r.lifetime.successCount}, errors ${r.lifetime.errorCount}, last ${ago(r.lifetime.lastUsedAt, now)}`,
  );
  lines.push(
    `${theme.muted("  Models:")} validated on ${r.models.validatedOn.length ? r.models.validatedOn.join(", ") : "n/a"}; read by ${r.models.readBy.length ? r.models.readBy.join(", ") : "none"}`,
  );
  if (r.descriptionRepairs > 0) {
    lines.push(`${theme.muted("  Description repairs:")} ${r.descriptionRepairs}`);
  }
  if (r.gateHistory.length > 0) {
    lines.push("");
    lines.push(theme.heading("Gate history (newest last):"));
    for (const h of r.gateHistory.slice(-8)) {
      lines.push(
        `  ${new Date(h.at).toISOString().slice(0, 16)} ${h.action.padEnd(10)} ${h.verdict.padEnd(10)}${h.score !== null ? ` ${h.score.toFixed(2)}` : ""}${h.detail ? ` ${theme.muted(h.detail)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
