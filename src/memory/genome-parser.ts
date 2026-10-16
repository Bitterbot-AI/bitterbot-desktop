/**
 * Parse GENOME.md for hormonal homeostasis values and phenotype constraints.
 *
 * GENOME.md is the agent's immutable core — safety axioms, personality baselines,
 * and guardrails on how the Phenotype can evolve. This parser extracts machine-readable
 * config from the human-editable markdown format.
 */

/**
 * Parse hormonal homeostasis values from GENOME.md.
 * Looks for a YAML code block under the "Hormonal Homeostasis" section.
 *
 * Expected format:
 * ```yaml
 * homeostasis:
 *   dopamine: 0.3
 *   cortisol: 0.15
 *   oxytocin: 0.4
 * ```
 */
export function parseGenomeHomeostasis(genomeContent: string): {
  dopamine?: number;
  cortisol?: number;
  oxytocin?: number;
} | null {
  // Find the YAML block in the Hormonal Homeostasis section
  const yamlMatch = genomeContent.match(
    /## Hormonal Homeostasis[\s\S]*?```ya?ml\s*\n([\s\S]*?)```/,
  );
  if (!yamlMatch?.[1]) {
    return null;
  }

  const yaml = yamlMatch[1];
  const result: Record<string, number> = {};

  // Simple key-value parsing (no full YAML parser needed)
  for (const line of yaml.split("\n")) {
    const match = line.match(/^\s*(dopamine|cortisol|oxytocin)\s*:\s*([\d.]+)/);
    if (match) {
      const value = parseFloat(match[2]!);
      if (!isNaN(value) && value >= 0 && value <= 1) {
        result[match[1]!] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse phenotype constraints from GENOME.md.
 * Returns the bullet-point constraints as an array of strings.
 */
export function parsePhenotypeConstraints(genomeContent: string): string[] {
  const section = genomeContent.match(/## Phenotype Constraints[\s\S]*?\n([\s\S]*?)(?=\n## |$)/);
  if (!section?.[1]) {
    return [];
  }

  return section[1]
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.replace(/^[\s-]+/, "").trim())
    .filter(Boolean);
}

// ── Temperament ─────────────────────────────────────────────────────────────

/**
 * The agent's starting voice, set in GENOME.md's `## Temperament` section by
 * a `level:` line. Dreams evolve the Phenotype from it; it does not change on
 * its own.
 */
export const TEMPERAMENT_LEVELS = ["calm", "playful", "irreverent"] as const;
export type TemperamentLevel = (typeof TEMPERAMENT_LEVELS)[number];
/** The level a section without a valid `level:` line (and a fresh setup) gets. */
export const DEFAULT_TEMPERAMENT_LEVEL: TemperamentLevel = "irreverent";

export function isTemperamentLevel(value: unknown): value is TemperamentLevel {
  return typeof value === "string" && (TEMPERAMENT_LEVELS as readonly string[]).includes(value);
}

export type GenomeTemperament = {
  level: TemperamentLevel;
  /** The section's bullet points (the voice, in the owner's words). */
  bullets: string[];
};

const TEMPERAMENT_HEADING_RE = /^##[ \t]+Temperament[ \t]*$/m;
const LEVEL_LINE_RE = /^[ \t]*level:[ \t]*([A-Za-z]+)[^\n]*$/m;

/** Start and end offsets of the `## Temperament` section (heading through the next `## `). */
export function findTemperamentSection(
  genomeContent: string,
): { start: number; end: number } | null {
  const heading = TEMPERAMENT_HEADING_RE.exec(genomeContent);
  if (!heading) {
    return null;
  }
  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const next = /^##[ \t]/m.exec(genomeContent.slice(afterHeading));
  const end = next ? afterHeading + next.index : genomeContent.length;
  return { start, end };
}

/**
 * Parse the Temperament section of GENOME.md. Null when the Genome has none
 * (an agent created before the section existed: it is offered, never added
 * silently). An unknown or missing `level:` reads as the default.
 */
export function parseGenomeTemperament(genomeContent: string): GenomeTemperament | null {
  const range = findTemperamentSection(genomeContent);
  if (!range) {
    return null;
  }
  const body = genomeContent.slice(range.start, range.end);
  const raw = LEVEL_LINE_RE.exec(body)?.[1]?.toLowerCase();
  const level = isTemperamentLevel(raw) ? raw : DEFAULT_TEMPERAMENT_LEVEL;
  const bullets = body
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.replace(/^[\s-]+/, "").trim())
    .filter(Boolean);
  return { level, bullets };
}

/**
 * Set the `level:` of an existing Temperament section, leaving every other
 * byte of the Genome as it was. Returns null when there is no section.
 */
export function setGenomeTemperamentLevel(
  genomeContent: string,
  level: TemperamentLevel,
): string | null {
  const range = findTemperamentSection(genomeContent);
  if (!range) {
    return null;
  }
  const body = genomeContent.slice(range.start, range.end);
  const levelLine = LEVEL_LINE_RE.exec(body);
  let nextBody: string;
  if (levelLine) {
    const current = levelLine[1] ?? "";
    const lineStart = levelLine.index;
    const valueStart = lineStart + levelLine[0].indexOf(current, levelLine[0].indexOf(":"));
    nextBody = body.slice(0, valueStart) + level + body.slice(valueStart + current.length);
  } else {
    // No level line: put one right under the heading.
    const headingEnd = body.indexOf("\n");
    nextBody =
      headingEnd === -1
        ? `${body}\n\nlevel: ${level}\n`
        : `${body.slice(0, headingEnd + 1)}\nlevel: ${level}\n${body.slice(headingEnd + 1)}`;
  }
  return genomeContent.slice(0, range.start) + nextBody + genomeContent.slice(range.end);
}

/**
 * Append a Temperament section to a Genome that has none, after everything
 * else (no other section is touched). Returns null when one is already there.
 */
export function appendGenomeTemperament(genomeContent: string, section: string): string | null {
  if (findTemperamentSection(genomeContent)) {
    return null;
  }
  // Keep the Genome's own line endings (a Genome edited on Windows is CRLF).
  const eol = genomeContent.includes("\r\n") ? "\r\n" : "\n";
  const head = genomeContent.replace(/\s+$/, "");
  const body = section.trim().replace(/\r?\n/g, eol);
  return `${head}${head ? eol + eol : ""}${body}${eol}`;
}
