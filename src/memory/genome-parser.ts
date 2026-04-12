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
