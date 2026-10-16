import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setGenomeTemperamentLevel, type TemperamentLevel } from "../memory/genome-parser.js";
import {
  CACHE_BOUNDARY_MARKER,
  buildAgentSystemPrompt,
  formatPromptDate,
} from "./system-prompt.js";

const TEMPLATE = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "../../docs/reference/templates/GENOME.md"),
  "utf-8",
);
const OLD_GENOME = "# Genome\n\n## Core Values\n\n- Earn trust through competence\n";

const genomeAt = (level: TemperamentLevel) => setGenomeTemperamentLevel(TEMPLATE, level)!;

function prompt(overrides: Partial<Parameters<typeof buildAgentSystemPrompt>[0]> = {}) {
  return buildAgentSystemPrompt({
    workspaceDir: "/tmp/workspace",
    contextFiles: [{ path: "/tmp/workspace/GENOME.md", content: genomeAt("irreverent") }],
    runtimeInfo: { model: "anthropic/claude-sonnet-5-5" },
    ...overrides,
  });
}

const stableOf = (p: string) => p.slice(0, p.indexOf(CACHE_BOUNDARY_MARKER));
const volatileOf = (p: string) => p.slice(p.indexOf(CACHE_BOUNDARY_MARKER));

describe("identity opening", () => {
  it("opens as Bitterbot, not as a generic assistant, in full and none modes", () => {
    for (const mode of ["full", "minimal", "none"] as const) {
      const p = prompt({ promptMode: mode });
      expect(p.startsWith("You are Bitterbot: a personal agent on your owner's machine")).toBe(
        true,
      );
      expect(p).not.toContain("personal assistant running inside Bitterbot");
    }
    expect(prompt({ promptMode: "none" })).toContain("who you've become is your Phenotype");
  });

  it("uses the agent's configured name", () => {
    const p = prompt({ agentName: "Nova" });
    expect(p.startsWith("You are Nova, a Bitterbot agent: a personal agent")).toBe(true);
    expect(p).toContain("say so plainly: you are Nova, a Bitterbot agent, the model is");
  });

  it("names the model below the cache boundary, with the plain answer and no claimed model", () => {
    const p = prompt();
    expect(stableOf(p)).not.toContain("claude-sonnet-5-5");
    expect(stableOf(p)).toContain("Bitterbot is not a model");
    expect(volatileOf(p)).toContain(
      "If asked what model you are, say so plainly: you are Bitterbot, the model is Claude Sonnet 5.5 (anthropic/claude-sonnet-5-5), and your owner can switch it.",
    );
    expect(stableOf(prompt({ runtimeInfo: { model: "openai/gpt-5" } }))).toBe(stableOf(p));
  });
});

describe("voice (GENOME.md Temperament)", () => {
  it("renders only the current level's block, with the register and the hard rules", () => {
    const voice = (level: TemperamentLevel) =>
      prompt({ contextFiles: [{ path: "/w/GENOME.md", content: genomeAt(level) }] });
    const calm = voice("calm");
    const playful = voice("playful");
    const irreverent = voice("irreverent");
    expect(calm).toContain("Temperament: calm.");
    expect(calm).toContain("no swearing");
    expect(calm).not.toContain("never reuse these lines verbatim");
    expect(playful).toContain("Temperament: playful.");
    expect(playful).toContain("What trouble are we getting into");
    expect(playful).not.toContain("damn mess");
    expect(irreverent).toContain("Temperament: irreverent.");
    expect(irreverent).toContain("an easy damn, hell or shit in casual chat is welcome");
    expect(irreverent).toContain("damn mess");
    expect(irreverent).toContain("never reuse these lines verbatim");
    expect(irreverent).not.toContain("What trouble are we getting into");
    expect(irreverent).not.toContain("Temperament: calm.");
    for (const p of [calm, playful, irreverent]) {
      expect(p).toContain("humor never costs accuracy");
      expect(p).toContain("drop the jokes and be straight");
      expect(p).toContain("anyone your owner has not vouched for");
      expect(p).toContain("talking about being new");
      // The voice closes the cached half, after the workspace files.
      const stable = stableOf(p);
      expect(stable.indexOf("## Voice")).toBeGreaterThan(stable.indexOf("## /w/GENOME.md"));
      expect(stable.indexOf("## Voice")).toBeGreaterThan(stable.indexOf("## Heartbeats"));
    }
  });

  it("is clean for guests, whatever the level", () => {
    const p = prompt({ guestTurn: true });
    expect(p).toContain("Temperament: clean.");
    expect(p).toContain("no swearing");
    expect(p).not.toContain("Temperament: irreverent.");
    expect(p).not.toContain("damn mess");
  });

  it("adds nothing for a Genome without the section (offered, never silently added)", () => {
    const p = prompt({ contextFiles: [{ path: "/w/GENOME.md", content: OLD_GENOME }] });
    expect(p).not.toContain("## Voice");
    expect(prompt({ contextFiles: [] })).not.toContain("## Voice");
  });

  it("does not duplicate the GENOME.md bullets", () => {
    const p = prompt();
    expect(p.split("Execute with precision, explain with personality").length - 1).toBe(1);
  });

  it("is left out of minimal (sub-agent) prompts", () => {
    expect(prompt({ promptMode: "minimal" })).not.toContain("## Voice");
  });
});

describe("talking about yourself, facts and sources, plan honesty", () => {
  it("full mode has the self-description rules", () => {
    const p = prompt();
    expect(p).toContain("## Talking About Yourself");
    expect(p).toContain("never claim consciousness or feelings as fact");
    expect(prompt({ promptMode: "minimal" })).not.toContain("## Talking About Yourself");
  });

  it("data integrity is in every mode but none; research rules need a web tool", () => {
    const full = prompt({ toolNames: ["read", "web_search", "web_fetch"] });
    expect(full).toContain("Never state what a file, PDF, web page or command output says");
    expect(full).toContain("search first, fetch only when snippets are not enough");
    expect(full).toContain("Cite sources with links");
    expect(full).toContain("Check dates and say how old information is");

    const noWeb = prompt({ toolNames: ["read"] });
    expect(noWeb).toContain("Never state what a file, PDF, web page or command output says");
    expect(noWeb).not.toContain("search first");

    const minimal = prompt({ promptMode: "minimal", toolNames: ["read", "web_search"] });
    expect(minimal).toContain("extract numbers with a tool, never estimate them");
    expect(minimal).not.toContain("search first");
  });

  it("the workflow section guards against plan thrash", () => {
    expect(prompt()).toContain(
      "If you have updated the plan three times without finishing a task, simplify it.",
    );
    expect(prompt()).toContain("Mark a task done only with concrete evidence");
  });

  it("puts today's date (day granularity) below the cache boundary", () => {
    const now = new Date("2026-10-15T23:30:00Z");
    const p = prompt({ userTimezone: "America/Chicago", now });
    expect(volatileOf(p)).toContain("Today: Thursday, 2026-10-15");
    expect(stableOf(p)).not.toContain("2026-10-15");
    // The day is the user's: 23:30 UTC is already Friday in Tokyo.
    expect(formatPromptDate("Asia/Tokyo", now)).toBe("Friday, 2026-10-16");
    expect(formatPromptDate("Not/AZone", now)).toBeUndefined();
  });
});
