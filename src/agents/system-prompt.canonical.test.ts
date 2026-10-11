/**
 * PLAN-33 Phase 1 — the Canonical Facts block in the system prompt.
 *
 * The determinism contract: when a rendered block is supplied it appears in
 * the prompt in BOTH full and minimal modes, independent of endocrine state
 * (a hormonal failure must never drop ground truth).
 */
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const BLOCK = [
  "## Canonical Facts",
  "Ground truth, maintained by memory consolidation.",
  "- [project.repo] The project repository is github.com/Bitterbot-AI/bitterbot-desktop. (confirmed 41x, last 2026-07-10)",
].join("\n");

describe("canonical facts in the system prompt", () => {
  it("renders in full mode, without requiring endocrine state", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      canonicalFacts: BLOCK,
      // No endocrineState on purpose — the block must not depend on it.
    });
    expect(prompt).toContain("## Canonical Facts");
    expect(prompt).toContain("github.com/Bitterbot-AI/bitterbot-desktop");
  });

  it("renders in minimal (subagent) mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      promptMode: "minimal",
      canonicalFacts: BLOCK,
    });
    expect(prompt).toContain("## Canonical Facts");
  });

  it("adds nothing when no block is supplied", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot" });
    expect(prompt).not.toContain("## Canonical Facts");
  });
});

describe("research findings in the system prompt (PLAN-34 Phase 2b)", () => {
  const FINDINGS_BLOCK = [
    "## Research Findings",
    "While idle, background research looked into open curiosity gaps.",
    '- Looked into "X" — ingested "x-skill" from docs.example.com (source: https://docs.example.com/x)',
  ].join("\n");

  it("renders without requiring endocrine state (the finding survives an endocrine failure)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      researchFindings: FINDINGS_BLOCK,
      // No endocrineState on purpose — resolveEndocrineState returning
      // undefined must never drop the finding.
    });
    expect(prompt).toContain("## Research Findings");
    expect(prompt).toContain('Looked into "X"');
  });

  it("adds nothing when no block is supplied", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot" });
    expect(prompt).not.toContain("## Research Findings");
  });
});

/**
 * PLAN-55 Phase 1: the Memory section names memory_pin as THE tool for
 * corrections and settled facts; working_memory_note is scratch.
 */
describe("memory_pin in the Memory section", () => {
  const tools = ["memory_search", "memory_get", "memory_pin", "working_memory_note"];

  it("lists memory_pin for corrections, with evidence and scope, when the tool is available", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot", toolNames: tools });
    expect(prompt).toMatch(/`memory_pin`: THE tool for corrections and settled facts/);
    expect(prompt).toContain("evidence: their words quoted");
    expect(prompt).toContain("scope: global | project:<name> | person:<name>");
    expect(prompt).toContain("held for the owner's confirmation");
    expect(prompt).toMatch(/`working_memory_note`: scratch/);
    expect(prompt).toContain("Not for corrections or settled facts: those go to `memory_pin`.");
    expect(prompt).not.toMatch(
      /working_memory_note`: persist anything worth keeping \(user facts, decisions, preferences, corrections/,
    );
  });

  it("omits the memory_pin line when the ledger tool is not available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      toolNames: ["memory_search", "memory_get", "working_memory_note"],
    });
    expect(prompt).not.toContain("`memory_pin`: THE tool");
    // Without the ledger tool, working_memory_note is still the place for
    // corrections: the prompt never points at a tool the model cannot see.
    expect(prompt).not.toMatch(/`working_memory_note`: scratch/);
    expect(prompt).toMatch(
      /`working_memory_note`: persist anything worth keeping \(user facts, decisions, preferences, corrections/,
    );
  });
});
