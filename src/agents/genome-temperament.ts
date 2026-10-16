/**
 * The owner's side of GENOME.md's Temperament section: show it, add it to a
 * Genome that predates it, change its level.
 *
 * New workspaces get the section from the GENOME.md template. Existing
 * agents are offered it (`bitterbot genome temperament`, the Control UI
 * card); nothing here runs unless the owner asks. Only the Temperament
 * section is ever written: every other byte of the Genome stays as it was.
 *
 * The agent cannot reach these writes (the genome guard blocks its tools).
 * They are the owner's, so each one is announced to the guard first (a tool
 * call in flight must keep the owner's version, see noteGenomeWrittenByUser)
 * and the previous Genome is copied next to the guard's rejected versions.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  appendGenomeTemperament,
  DEFAULT_TEMPERAMENT_LEVEL,
  findTemperamentSection,
  parseGenomeTemperament,
  setGenomeTemperamentLevel,
  type TemperamentLevel,
} from "../memory/genome-parser.js";
import { genomeFileOf, MAX_GENOME_BYTES, noteGenomeWrittenByUser } from "./genome-guard.js";
import { DEFAULT_GENOME_FILENAME, loadWorkspaceTemplate } from "./workspace.js";

export type TemperamentStatus = {
  genomePath: string;
  /** False: the workspace has no GENOME.md at all. */
  genomeExists: boolean;
  /** The Genome has a Temperament section. */
  present: boolean;
  /** The section's level when present. */
  level?: TemperamentLevel;
  /** The section as it is (present) or as it would be added (absent). */
  preview: string;
};

export type TemperamentWriteResult = {
  status: TemperamentStatus;
  changed: boolean;
  /** Copy of the Genome before the write. */
  backupPath?: string;
};

/** The Temperament section of the shipped GENOME.md template, at the given level. */
export async function templateTemperamentSection(
  level: TemperamentLevel = DEFAULT_TEMPERAMENT_LEVEL,
): Promise<string> {
  // LF, whatever the checkout: appendGenomeTemperament matches the Genome's own line endings.
  const template = (await loadWorkspaceTemplate(DEFAULT_GENOME_FILENAME)).replace(/\r\n?/g, "\n");
  const range = findTemperamentSection(template);
  if (!range) {
    throw new Error("The GENOME.md template has no Temperament section.");
  }
  const section = template.slice(range.start, range.end).trim();
  return (setGenomeTemperamentLevel(section, level) ?? section).trim();
}

async function readGenome(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      throw new Error(`${file} is not a regular file.`);
    }
    if (stat.size > MAX_GENOME_BYTES) {
      throw new Error(`${file} is larger than ${MAX_GENOME_BYTES} bytes.`);
    }
    return await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function statusOf(
  genomePath: string,
  content: string | null,
  sectionIfAbsent: string,
): TemperamentStatus {
  const parsed = content === null ? null : parseGenomeTemperament(content);
  const range = content === null ? null : findTemperamentSection(content);
  return {
    genomePath,
    genomeExists: content !== null,
    present: parsed !== null,
    ...(parsed ? { level: parsed.level } : {}),
    preview:
      content !== null && range ? content.slice(range.start, range.end).trim() : sectionIfAbsent,
  };
}

export async function readTemperamentStatus(
  workspaceDir: string,
  opts?: { previewLevel?: TemperamentLevel },
): Promise<TemperamentStatus> {
  const genomePath = genomeFileOf(workspaceDir);
  const content = await readGenome(genomePath);
  return statusOf(genomePath, content, await templateTemperamentSection(opts?.previewLevel));
}

/** Copy the Genome as it was before an owner write, beside the guard's rejected copies. */
async function backupGenome(content: string): Promise<string> {
  const dir = path.join(resolveStateDir(), "genome-guard");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const digest = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  const file = path.join(dir, `owner-previous-${Date.now()}-${digest}.md`);
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

/**
 * An owner write to GENOME.md: back up the previous content, tell the guard
 * the new content is the owner's, then replace the file atomically (keeping
 * its mode). A symlinked Genome is written through the link.
 */
export async function writeGenomeAsOwner(
  genomePath: string,
  previous: string,
  next: string,
): Promise<string> {
  const backupPath = await backupGenome(previous);
  noteGenomeWrittenByUser(genomePath, next);
  const target = await fs.realpath(genomePath).catch(() => genomePath);
  const mode = await fs
    .stat(target)
    .then((s) => s.mode & 0o777)
    .catch(() => 0o644);
  const temp = `${target}.temperament-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, next, { mode });
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
  return backupPath;
}

/** Add the Temperament section to a Genome that has none. Nothing else is touched. */
export async function addTemperament(
  workspaceDir: string,
  level: TemperamentLevel = DEFAULT_TEMPERAMENT_LEVEL,
): Promise<TemperamentWriteResult> {
  const genomePath = genomeFileOf(workspaceDir);
  const content = await readGenome(genomePath);
  const section = await templateTemperamentSection(level);
  if (content === null) {
    throw new Error(
      `No ${DEFAULT_GENOME_FILENAME} at ${genomePath}. Set up the workspace first (bitterbot setup).`,
    );
  }
  const next = appendGenomeTemperament(content, section);
  if (next === null) {
    return { status: statusOf(genomePath, content, section), changed: false };
  }
  const backupPath = await writeGenomeAsOwner(genomePath, content, next);
  return { status: statusOf(genomePath, next, section), changed: true, backupPath };
}

/** Change the level of an existing Temperament section. */
export async function setTemperamentLevel(
  workspaceDir: string,
  level: TemperamentLevel,
): Promise<TemperamentWriteResult> {
  const genomePath = genomeFileOf(workspaceDir);
  const content = await readGenome(genomePath);
  const section = await templateTemperamentSection(level);
  if (content === null) {
    throw new Error(
      `No ${DEFAULT_GENOME_FILENAME} at ${genomePath}. Set up the workspace first (bitterbot setup).`,
    );
  }
  const current = parseGenomeTemperament(content);
  if (!current) {
    throw new Error(
      `${DEFAULT_GENOME_FILENAME} has no Temperament section yet. Add it first (bitterbot genome temperament --add).`,
    );
  }
  const next = setGenomeTemperamentLevel(content, level);
  if (next === null || next === content) {
    return { status: statusOf(genomePath, content, section), changed: false };
  }
  const backupPath = await writeGenomeAsOwner(genomePath, content, next);
  return { status: statusOf(genomePath, next, section), changed: true, backupPath };
}

/**
 * Setup's vibe pick. A Genome with a Temperament section (every workspace
 * setup just created) gets the chosen level; one without it is left alone
 * and the caller points the owner at the offer instead.
 */
export async function applySetupVibe(
  workspaceDir: string,
  level: TemperamentLevel,
): Promise<"set" | "unchanged" | "missing"> {
  const content = await readGenome(genomeFileOf(workspaceDir)).catch(() => null);
  if (content === null || !parseGenomeTemperament(content)) {
    return "missing";
  }
  const result = await setTemperamentLevel(workspaceDir, level);
  return result.changed ? "set" : "unchanged";
}
