/**
 * Onboarding wizard step: introduce the GENOME.md (the agent's DNA).
 *
 * GENOME.md is auto-seeded with sane defaults during workspace bootstrap.
 * This step doesn't write anything — it surfaces the file's existence,
 * explains what it controls, and optionally opens the user's editor so they
 * can tune the immutable axioms before the agent starts shaping itself.
 *
 * Why a step at all instead of "go read the docs":
 *   - Operators rarely discover GENOME.md on their own
 *   - Defaults are reasonable but not always right (e.g. cortisol baseline
 *     for an agent meant to handle urgent ops is too low at 0.15)
 *   - Editing the file IS the supported tuning interface — there is no GUI
 *
 * Skip in quickstart; surface in advanced mode.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { DEFAULT_GENOME_FILENAME } from "../agents/workspace.js";

export async function setupGenomeForOnboarding(params: {
  workspaceDir: string;
  flow: WizardFlow;
  prompter: WizardPrompter;
}): Promise<void> {
  const { workspaceDir, flow, prompter } = params;

  if (flow === "quickstart") {
    return;
  }

  const genomePath = path.join(workspaceDir, DEFAULT_GENOME_FILENAME);
  const exists = await fs
    .stat(genomePath)
    .then((s) => s.isFile())
    .catch(() => false);

  if (!exists) {
    // Workspace bootstrap should have seeded it; if it's missing the agent
    // can still run with library defaults, just less self-aware. Don't block.
    await prompter.note(
      [
        `${DEFAULT_GENOME_FILENAME} wasn't found at ${genomePath}.`,
        "The agent will run with library defaults. Bootstrap the workspace",
        "to seed it explicitly: `bitterbot agents bootstrap`.",
      ].join("\n"),
      "Genome",
    );
    return;
  }

  await prompter.note(
    [
      "GENOME.md is your agent's DNA — the immutable core that dreams,",
      "mutations, and personality evolution can never override:",
      "",
      "  - Safety axioms (never exfiltrate, never bypass oversight, etc.)",
      "  - Hormonal homeostasis (resting dopamine / cortisol / oxytocin)",
      "  - Phenotype constraints (how the personality can evolve)",
      "  - Core values (what the agent treats as sacred)",
      "",
      "Defaults are sane: motivated, calm, warm. But they're tuned for a",
      "general-purpose assistant, not your specific use case. An agent",
      "meant to triage urgent ops wants higher cortisol baseline; one",
      "meant for solo creative work wants higher dopamine and lower oxytocin.",
      "",
      `File: ${genomePath}`,
      "",
      "You can edit it now or anytime — it's plain markdown + YAML.",
      "Changes take effect on the next gateway restart.",
    ].join("\n"),
    "Genome — your agent's DNA",
  );

  const wantsToEdit = await prompter.confirm({
    message: "Open GENOME.md in your editor now?",
    initialValue: false,
  });

  if (!wantsToEdit) {
    return;
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "nano";
  await new Promise<void>((resolve) => {
    const child = spawn(editor, [genomePath], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", async () => {
      await prompter.note(
        [`Couldn't launch ${editor}. Open the file manually:`, `  ${genomePath}`].join("\n"),
        "Editor unavailable",
      );
      resolve();
    });
  });
}
