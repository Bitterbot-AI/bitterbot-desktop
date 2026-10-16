import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  appendGenomeTemperament,
  parseGenomeHomeostasis,
  parseGenomeTemperament,
  parsePhenotypeConstraints,
  setGenomeTemperamentLevel,
} from "./genome-parser.js";

const GENOME_TEMPLATE_PATH = resolve(
  import.meta.dirname ?? __dirname,
  "../../docs/reference/templates/GENOME.md",
);

describe("Genome Parser", () => {
  describe("parseGenomeHomeostasis", () => {
    it("parses homeostasis values from GENOME.md template", () => {
      const genomeMd = readFileSync(GENOME_TEMPLATE_PATH, "utf-8");
      const result = parseGenomeHomeostasis(genomeMd);

      expect(result).not.toBeNull();
      expect(result!.dopamine).toBeTypeOf("number");
      expect(result!.cortisol).toBeTypeOf("number");
      expect(result!.oxytocin).toBeTypeOf("number");
      // Values should be between 0 and 1
      expect(result!.dopamine).toBeGreaterThanOrEqual(0);
      expect(result!.dopamine).toBeLessThanOrEqual(1);
      expect(result!.cortisol).toBeGreaterThanOrEqual(0);
      expect(result!.cortisol).toBeLessThanOrEqual(1);
      expect(result!.oxytocin).toBeGreaterThanOrEqual(0);
      expect(result!.oxytocin).toBeLessThanOrEqual(1);
    });

    it("parses exact template defaults", () => {
      const genomeMd = readFileSync(GENOME_TEMPLATE_PATH, "utf-8");
      const result = parseGenomeHomeostasis(genomeMd);

      expect(result).toEqual({
        dopamine: 0.3,
        cortisol: 0.15,
        oxytocin: 0.4,
      });
    });

    it("returns null for non-GENOME content", () => {
      const result = parseGenomeHomeostasis("# Just a regular markdown file\nNo YAML here.");
      expect(result).toBeNull();
    });

    it("returns null for missing homeostasis section", () => {
      const result = parseGenomeHomeostasis("## Some Other Section\nContent here.");
      expect(result).toBeNull();
    });

    it("returns null for malformed YAML", () => {
      const content = "## Hormonal Homeostasis\n```yaml\nhomeostasis:\n  bad: [invalid\n```";
      const result = parseGenomeHomeostasis(content);
      // No valid dopamine/cortisol/oxytocin keys → null
      expect(result).toBeNull();
    });

    it("ignores out-of-range values", () => {
      const content = `## Hormonal Homeostasis
\`\`\`yaml
homeostasis:
  dopamine: 1.5
  cortisol: -0.1
  oxytocin: 0.5
\`\`\``;
      const result = parseGenomeHomeostasis(content);
      // Only oxytocin is in range
      expect(result).toEqual({ oxytocin: 0.5 });
    });
  });

  describe("parsePhenotypeConstraints", () => {
    it("parses constraints from GENOME.md template", () => {
      const genomeMd = readFileSync(GENOME_TEMPLATE_PATH, "utf-8");
      const result = parsePhenotypeConstraints(genomeMd);

      expect(result.length).toBeGreaterThan(0);
      // Template has constraints about generalist, persona, sycophancy, communication style
      expect(result.some((c) => c.includes("generalist"))).toBe(true);
      expect(result.some((c) => c.includes("sycophancy"))).toBe(true);
    });

    it("returns empty array for content without constraints", () => {
      const result = parsePhenotypeConstraints("# Regular file\nNo constraints here.");
      expect(result).toEqual([]);
    });

    it("strips leading dashes and whitespace", () => {
      const content = `## Phenotype Constraints
- First constraint
- Second constraint
  - Nested should be caught too`;
      const result = parsePhenotypeConstraints(content);
      expect(result[0]).toBe("First constraint");
      expect(result[1]).toBe("Second constraint");
    });
  });

  describe("Temperament", () => {
    const template = () => readFileSync(GENOME_TEMPLATE_PATH, "utf-8");
    const OLD_GENOME = [
      "# Genome",
      "",
      "## Safety Axioms",
      "",
      "- Never exfiltrate private data",
      "",
      "## Core Values",
      "",
      "- Earn trust through competence",
      "",
    ].join("\n");

    it("parses the template's section: irreverent by default, the voice bullets", () => {
      const parsed = parseGenomeTemperament(template());
      expect(parsed?.level).toBe("irreverent");
      expect(parsed?.bullets).toHaveLength(8);
      expect(parsed?.bullets[0]).toMatch(/^Execute with precision/);
      // The Temperament bullets never leak into the phenotype constraints.
      expect(parsePhenotypeConstraints(template()).join(" ")).not.toContain("mischievous");
    });

    it("returns null for a Genome that predates the section", () => {
      expect(parseGenomeTemperament(OLD_GENOME)).toBeNull();
    });

    it("reads an unknown or missing level as the default", () => {
      expect(parseGenomeTemperament("## Temperament\n\nlevel: feral\n- x\n")?.level).toBe(
        "irreverent",
      );
      expect(parseGenomeTemperament("## Temperament\n\n- x\n")?.level).toBe("irreverent");
      expect(parseGenomeTemperament("## Temperament\nlevel:  Calm  # note\n")?.level).toBe("calm");
    });

    it("changes only the level value, every other byte stays", () => {
      const before = template();
      const after = setGenomeTemperamentLevel(before, "calm");
      expect(after).not.toBeNull();
      expect(parseGenomeTemperament(after!)?.level).toBe("calm");
      expect(after!.replace("level: calm #", "level: irreverent #")).toBe(before);
      expect(setGenomeTemperamentLevel(OLD_GENOME, "calm")).toBeNull();
    });

    it("adds a level line to a section without one", () => {
      const genome = `${OLD_GENOME}\n## Temperament\n\n- Dry.\n`;
      const after = setGenomeTemperamentLevel(genome, "playful")!;
      expect(parseGenomeTemperament(after)).toEqual({ level: "playful", bullets: ["Dry."] });
      expect(after.startsWith(OLD_GENOME)).toBe(true);
    });

    it("appends the section after everything else, once", () => {
      const section = "## Temperament\n\nlevel: calm\n\n- Dry.";
      const after = appendGenomeTemperament(OLD_GENOME, section)!;
      expect(after.startsWith(OLD_GENOME.trimEnd())).toBe(true);
      expect(after.endsWith("- Dry.\n")).toBe(true);
      expect(parsePhenotypeConstraints(after)).toEqual(parsePhenotypeConstraints(OLD_GENOME));
      expect(parseGenomeTemperament(after)?.level).toBe("calm");
      expect(appendGenomeTemperament(after, section)).toBeNull();
    });

    it("keeps a CRLF Genome CRLF and parses it", () => {
      const crlf = OLD_GENOME.replace(/\n/g, "\r\n");
      const after = appendGenomeTemperament(crlf, "## Temperament\n\nlevel: playful\n\n- Dry.")!;
      expect(after.replace(/\r\n/g, "")).not.toContain("\n");
      expect(parseGenomeTemperament(after)).toEqual({ level: "playful", bullets: ["Dry."] });
      expect(parseGenomeTemperament(setGenomeTemperamentLevel(after, "calm")!)?.level).toBe("calm");
    });
  });
});
