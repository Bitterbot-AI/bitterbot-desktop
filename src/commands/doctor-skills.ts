/**
 * Top-level Skills (P2P) doctor section.
 *
 * Skills are discrete capabilities (tools, prompts, genomes) that the
 * agent can publish and ingest over the P2P mesh. Ingestion is the
 * dangerous direction — a hostile skill can poison the agent — so the
 * `skills.p2p.ingestPolicy` gate decides whether new skills are:
 *
 *   - "review"  → quarantined, require manual approval (safe default)
 *   - "auto"    → accepted automatically from trusted signers
 *   - "deny"    → mesh-published skills are rejected entirely
 *
 * What we check:
 *   1. Policy value is one of the three expected values
 *   2. If "auto", a non-empty trust list is set (otherwise "auto" is
 *      effectively "deny" and the operator probably meant review)
 *   3. Quarantine directory exists and is writable
 *
 * What we deliberately don't check:
 *   - Contents of the trust list (signing identities aren't verifiable
 *     without network + gossipsub; that's orchestrator territory)
 *   - Skill verifier binaries (loaded by plugin runtime)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const error = (message: string): CheckResult => ({ level: "error", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `\u2714 ${r.message}`;
    case "warn":
      return `\u26A0 ${r.message}`;
    case "error":
      return `\u2718 ${r.message}`;
    case "info":
      return `\u2139 ${r.message}`;
  }
}

const DEFAULT_QUARANTINE_DIR = path.join(os.homedir(), ".bitterbot", "skills", "quarantine");

export function runSkillsChecks(params: { config: BitterbotConfig }): void {
  const { config } = params;
  const p2p = config.skills?.p2p;
  const results: CheckResult[] = [];

  // ── Policy ──
  const policy = p2p?.ingestPolicy ?? "review";
  if (policy !== "review" && policy !== "auto" && policy !== "deny") {
    results.push(error(`Unknown skills.p2p.ingestPolicy "${String(policy)}"`));
    renderSection(results);
    return;
  }

  if (policy === "deny") {
    results.push(info("Skill ingestion: deny (mesh-published skills will be rejected)"));
  } else if (policy === "review") {
    results.push(ok("Skill ingestion: review (quarantine + manual approval — safe default)"));
  } else {
    // auto
    const trustList = p2p?.trustList ?? [];
    if (trustList.length === 0) {
      results.push(
        error(
          [
            'Skill ingestion is set to "auto" but no trust list is configured.',
            "  Without trusted signers, auto-ingest will reject every skill — effectively deny.",
            `  Fix: ${formatCliCommand("bitterbot config set skills.p2p.trustList '[\"<peer-id>\"]'")}`,
            `  Or switch back to review: ${formatCliCommand(
              "bitterbot config set skills.p2p.ingestPolicy review",
            )}`,
          ].join("\n"),
        ),
      );
    } else {
      results.push(
        warn(
          `Skill ingestion: auto (${trustList.length} trusted signer${
            trustList.length === 1 ? "" : "s"
          }). Poisoned skills from a trusted peer will run unattended — review recommended unless the trust list is audited.`,
        ),
      );
    }
  }

  // ── Rate limit ──
  if (p2p?.maxIngestedPerHour !== undefined) {
    results.push(ok(`Ingest rate cap: ${p2p.maxIngestedPerHour}/hr`));
  }

  // ── Quarantine directory ──
  if (policy !== "deny") {
    const dirRaw = p2p?.quarantineDir?.trim() || DEFAULT_QUARANTINE_DIR;
    const dir = resolveUserPath(dirRaw);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      results.push(ok(`Quarantine dir: ${dir}`));
    } catch (err) {
      results.push(
        error(
          `Quarantine dir ${dir} not writable: ` +
            (err instanceof Error ? err.message : String(err)),
        ),
      );
    }
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Skills (P2P ingest)");
}
