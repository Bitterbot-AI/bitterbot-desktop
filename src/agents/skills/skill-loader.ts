/**
 * PLAN-52 Phase 5: skill discovery and the skills block of the system prompt.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono):
 * - `core/skills.js`: `loadSkillsFromDir`, `formatSkillsForPrompt`, the `Skill`
 *   type and the private helpers they reach (`loadSkillsFromDirInternal`,
 *   `loadSkillFromFile`, `validateName`, `validateDescription`,
 *   `createSkillSourceInfo`, `addIgnoreRules`, `prefixIgnorePattern`,
 *   `escapeXml`).
 * - `utils/frontmatter.js`: `parseFrontmatter` (frontmatter half only).
 * - `core/source-info.js`: `createSyntheticSourceInfo`.
 * The gitignore matcher pi takes from the `ignore` package is ported in
 * `skill-ignore.ts`. YAML parsing uses the `yaml` package, as pi does.
 *
 * `formatSkillsForPrompt` goes into the system prompt. Its output must stay
 * byte for byte what pi produces, or the prompt cache prefix changes for every
 * user.
 *
 * Differences from the original:
 *
 * 1. Typing. pi's `SourceInfo` is `SkillSourceInfo` here and pi's
 *    `ResourceDiagnostic` is `SkillDiagnostic`. `SkillDiagnostic` has no
 *    `collision` field and its `type` is always "warning", because only
 *    `loadSkills` reports collisions and errors and it is not ported.
 * 2. Not ported: `loadSkills` (the multi-location loader with the user and
 *    project default directories, `~` expansion and name-collision
 *    diagnostics). Nothing in this repo calls it.
 * 3. The markdown body after the frontmatter is not computed; pi computes it
 *    and the skill loader drops it.
 * 4. Frontmatter that parses to something other than a YAML mapping (a scalar
 *    or a list) is read as having no fields. pi reads properties off the
 *    parsed value directly, which gives the same result for every value YAML
 *    can produce.
 * 5. A truthy `description` or `name` that is not a string (a number, `true`,
 *    a list, a mapping) fails in pi with the JavaScript engine's TypeError
 *    from calling a string method on it, and the error message becomes the
 *    diagnostic. The port throws a TypeError with the message V8 produces
 *    ("description.trim is not a function", "name.startsWith is not a
 *    function") so the diagnostics are equal under Node. Under another engine
 *    pi's message would differ from this fixed text.
 *
 * Kept as in pi, on purpose:
 * - A directory with a `SKILL.md` file is a skill root: nothing else in it is
 *   loaded and its subdirectories are not scanned, even when that `SKILL.md`
 *   fails to load. A `SKILL.md` that is ignored or is not a file does not stop
 *   the scan.
 * - Other `.md` files are loaded as skills only directly in the scanned root,
 *   never in subdirectories. Their fallback name is the root directory's name.
 * - Entries starting with "." and `node_modules` are skipped at every level.
 * - Symlinks are followed (file or directory); a broken symlink is skipped.
 *   Nothing detects a symlink cycle; the walk ends when the OS refuses the
 *   path.
 * - `.gitignore`, `.ignore` and `.fdignore` are read in every scanned
 *   directory and all feed one matcher for the whole walk. Each pattern gets
 *   the directory's path relative to the root as a prefix, so a pattern
 *   without a slash in a nested ignore file only matches directly in that
 *   directory (git would match it at any depth below). The pattern keeps its
 *   leading whitespace. An escaped leading `\!` loses the backslash before the
 *   matcher sees it, so in the root directory it negates instead of matching a
 *   literal "!".
 * - Results come in `readdirSync` order, which the OS decides. Nothing sorts.
 * - A skill with warnings still loads, unless the description is missing or
 *   blank. The description is stored untrimmed.
 * - `name` falls back to the parent directory name when the frontmatter has
 *   none (or a falsy one).
 * - `disableModelInvocation` is true only for a YAML boolean `true`, not for
 *   the string "true".
 * - Any error while reading or parsing a skill file becomes a warning
 *   diagnostic carrying the error message, and the skill is dropped. Any error
 *   while scanning a directory is swallowed and the skills found so far in
 *   that directory are returned.
 * - Duplicate names are not detected here; both skills are returned.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { createSkillIgnoreMatcher, type SkillIgnoreMatcher } from "./skill-ignore.js";

export type SkillSourceScope = "user" | "project" | "temporary";
export type SkillSourceOrigin = "package" | "top-level";

/** Where a skill came from. pi calls this `SourceInfo`. */
export interface SkillSourceInfo {
  /** Path of the skill file. */
  path: string;
  /** The `source` given to `loadSkillsFromDir`, or "local" for user/project/path. */
  source: string;
  scope: SkillSourceScope;
  origin: SkillSourceOrigin;
  /** Directory of the skill file. */
  baseDir?: string;
}

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the skill's markdown file (when the scanned dir is absolute). */
  filePath: string;
  /** Directory that holds `filePath`. */
  baseDir: string;
  sourceInfo: SkillSourceInfo;
  /** True when the frontmatter sets `disable-model-invocation: true`. */
  disableModelInvocation: boolean;
}

/** A problem found while loading a skill file. pi calls this `ResourceDiagnostic`. */
export interface SkillDiagnostic {
  type: "warning";
  message: string;
  /** The skill file the message is about. */
  path: string;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface LoadSkillsFromDirOptions {
  /** Directory to scan for skills. */
  dir: string;
  /** Source identifier for these skills. */
  source: string;
}

/** Max name length per the Agent Skills spec. */
const MAX_NAME_LENGTH = 64;
/** Max description length per the Agent Skills spec. */
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return null;
  }
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: SkillIgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) {
      continue;
    }
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) {
        ig.add(patterns);
      }
    } catch {
      // Unreadable ignore file: scan as if it were not there.
    }
  }
}

/**
 * Validate a skill name per the Agent Skills spec.
 * Returns the validation error messages (empty when valid).
 */
function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }
  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }
  return errors;
}

/** Validate a description per the Agent Skills spec. */
function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

function createSyntheticSourceInfo(
  path: string,
  options: { source: string; scope?: SkillSourceScope; baseDir?: string },
): SkillSourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? "temporary",
    origin: "top-level",
    baseDir: options.baseDir,
  };
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SkillSourceInfo {
  switch (source) {
    case "user":
      return createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir });
    case "project":
      return createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir });
    case "path":
      return createSyntheticSourceInfo(filePath, { source: "local", baseDir });
    default:
      return createSyntheticSourceInfo(filePath, { source, baseDir });
  }
}

/**
 * The YAML frontmatter of a markdown file as a field map; empty when the file
 * has no frontmatter block. Throws what the YAML parser throws.
 */
function parseSkillFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return {};
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {};
  }
  const yamlString = normalized.slice(4, endIndex);
  if (!yamlString) {
    return {};
  }
  const parsed: unknown = parseYaml(yamlString);
  // A scalar or null has none of the fields read below (difference 4).
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
  const { dir, source } = options;
  return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  ignoreMatcher?: SkillIgnoreMatcher,
  rootDir?: string,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }
  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? createSkillIgnoreMatcher();
  addIgnoreRules(ig, dir, root);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== "SKILL.md") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      if (!isFile || ig.ignores(relPath)) {
        continue;
      }
      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
      return { skills, diagnostics };
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      // Skip node_modules to avoid scanning dependencies.
      if (entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      // For symlinks, check what they point to and follow them.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          // Broken symlink, skip it.
          continue;
        }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDirectory ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }
      if (isDirectory) {
        const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
        skills.push(...subResult.skills);
        diagnostics.push(...subResult.diagnostics);
        continue;
      }
      if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
        continue;
      }
      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
    }
  } catch {
    // Unreadable directory or a matcher error: return what was found so far.
  }
  return { skills, diagnostics };
}

function loadSkillFromFile(
  filePath: string,
  source: string,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const frontmatter = parseSkillFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);

    // Validate description. A truthy non-string fails as in pi (difference 5).
    const rawDescription = frontmatter.description;
    if (rawDescription && typeof rawDescription !== "string") {
      throw new TypeError("description.trim is not a function");
    }
    const description = typeof rawDescription === "string" ? rawDescription : undefined;
    for (const error of validateDescription(description)) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Use name from frontmatter, or fall back to parent directory name.
    const rawName = frontmatter.name || parentDirName;
    if (typeof rawName !== "string") {
      throw new TypeError("name.startsWith is not a function");
    }
    const name = rawName;
    for (const error of validateName(name, parentDirName)) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Still load the skill even with warnings (unless description is completely missing).
    if (!description || description.trim() === "") {
      return { skill: null, diagnostics };
    }
    return {
      skill: {
        name,
        description,
        filePath,
        baseDir: skillDir,
        sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
        disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      },
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skill: null, diagnostics };
  }
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per the Agent Skills standard (https://agentskills.io/integrate-skills).
 *
 * Skills with `disableModelInvocation` set are left out. Returns "" when no
 * skill is visible.
 */
export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
