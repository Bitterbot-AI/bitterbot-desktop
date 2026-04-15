import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";

export async function setupInternalHooks(
  cfg: BitterbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<BitterbotConfig> {
  await prompter.note(
    [
      "Hooks are autonomous background triggers — they run when something",
      "happens, not because you asked. They are how the agent learns,",
      "remembers, and acts while you're not looking.",
      "",
      "A few of the built-ins:",
      "  - session-memory — crystallize session context into memory on /new",
      "    (the dream engine works on what this captures)",
      "  - command-logger — record every /command for replay + audit",
      "  - boot-md       — prime working memory from MEMORY.md at start",
      "  - bootstrap-extra-files — pull referenced files on workspace init",
      "",
      "Plugins register their own hooks too (gmail-watcher for inbox",
      "processing, wake-up for scheduled triggers, heartbeat for liveness).",
      "",
      "Enable more later with `bitterbot hooks enable <name>`.",
      "Docs: https://docs.bitterbot.ai/automation/hooks",
    ].join("\n"),
    "Hooks",
  );

  // Discover available hooks using the hook discovery system
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceHookStatus(workspaceDir, { config: cfg });

  // Show every eligible hook so users can opt in during onboarding.
  const eligibleHooks = report.hooks.filter((h) => h.eligible);

  if (eligibleHooks.length === 0) {
    await prompter.note(
      "No eligible hooks found. You can configure hooks later in your config.",
      "No Hooks Available",
    );
    return cfg;
  }

  const toEnable = await prompter.multiselect({
    message: "Which hooks should fire autonomously?",
    options: [
      { value: "__skip__", label: "None for now — I'll enable them later" },
      ...eligibleHooks.map((hook) => ({
        value: hook.name,
        label: `${hook.emoji ?? "🔗"} ${hook.name}`,
        hint: hook.description,
      })),
    ],
  });

  const selected = toEnable.filter((name) => name !== "__skip__");
  if (selected.length === 0) {
    return cfg;
  }

  // Enable selected hooks using the new entries config format
  const entries = { ...cfg.hooks?.internal?.entries };
  for (const name of selected) {
    entries[name] = { enabled: true };
  }

  const next: BitterbotConfig = {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        enabled: true,
        entries,
      },
    },
  };

  await prompter.note(
    [
      `Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
      "",
      "You can manage hooks later with:",
      `  ${formatCliCommand("bitterbot hooks list")}`,
      `  ${formatCliCommand("bitterbot hooks enable <name>")}`,
      `  ${formatCliCommand("bitterbot hooks disable <name>")}`,
    ].join("\n"),
    "Hooks Configured",
  );

  return next;
}
