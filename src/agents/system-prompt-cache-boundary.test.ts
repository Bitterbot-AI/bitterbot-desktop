/**
 * Token-efficiency W4: the cache boundary in the system prompt.
 *
 * Contract: everything above `<!-- BITTERBOT_CACHE_BOUNDARY -->` is
 * byte-identical across turns of one session, however hormones, peer
 * counts, canonical-fact dates, runtime channel or working memory move.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchP2pStatus, resetP2pStatus } from "../infra/p2p-status.js";
import { stripCanonicalFactMetadata } from "./canonical-facts-block.js";
import {
  CACHE_BOUNDARY_MARKER,
  assembleSystemPromptWithBoundary,
  digestSystemPromptHalves,
  digestToolDefinitions,
  normalizeStablePromptText,
  splitSystemPromptAtBoundary,
} from "./system-prompt-cache-boundary.js";
import { bucketHormone, hormoneLevelLabel } from "./system-prompt-endocrine.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SKILLS = [
  "<available_skills>",
  "  <skill>",
  "    <name>demo</name>",
  "    <description>Use when the user asks for a demo. Not for production.</description>",
  "    <location>/tmp/skills/demo/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

function buildPrompt(variant: {
  dopamine: number;
  peerCount: number;
  factDate: string;
  channel: string;
  memory: string;
}) {
  patchP2pStatus({
    enabled: true,
    connected: true,
    peerCount: variant.peerCount,
    peerId: "12D3KooWQMptNZvAvA39NUAJur8NZN82AQBZ6bVoZ5y5H7WrHJVM",
    nodeTier: "edge",
    peersByTier: { edge: variant.peerCount },
    networkHealthScore: variant.peerCount / 10,
    telemetryCountsByType: { novelty: variant.peerCount * 3 },
    anomalyAlertCount: variant.peerCount % 2,
  });
  return buildAgentSystemPrompt({
    workspaceDir: "/tmp/bitterbot",
    toolNames: ["write", "read", "exec", "memory_search", "gateway", "wallet", "circles"],
    toolSummaries: { read: "ignored" },
    skillsPrompt: SKILLS,
    docsPath: "/tmp/bitterbot/docs",
    userTimezone: "Europe/Madrid",
    modelAliasLines: ["- opus: anthropic/claude-opus-4-8"],
    heartbeatPrompt: "Read HEARTBEAT.md if it exists.",
    contextFiles: [
      { path: "/ws/GENOME.md", content: "axioms" },
      { path: "/ws/PROTOCOLS.md", content: "procedures" },
      { path: "/ws/TOOLS.md", content: "tools notes" },
      { path: "/ws/MEMORY.md", content: variant.memory },
      { path: "/ws/memory/scratch.md", content: `- [${variant.factDate}] note` },
    ],
    endocrineState: {
      dopamine: variant.dopamine,
      cortisol: 0.31,
      oxytocin: 0.12,
      briefing: "steady",
      proactiveMemories: `Recalled: ${variant.factDate}`,
      budgetPressure: 0.55,
    },
    // Production strips counts/dates before the block reaches the prompt
    // (canonical-facts-block.ts); the fixture mirrors that.
    canonicalFacts: stripCanonicalFactMetadata(
      `## Canonical Facts\n- [user.name] The user is Victor. (confirmed 3x, last ${variant.factDate})`,
    ),
    reactionGuidance: { level: "minimal", channel: variant.channel },
    runtimeInfo: {
      host: "box",
      os: "linux",
      arch: "x64",
      node: "v22",
      model: "anthropic/claude-opus-4-8",
      channel: variant.channel,
      capabilities: ["inlineButtons"],
    },
  });
}

describe("cache boundary: stable half is invariant across turns", () => {
  beforeEach(() => resetP2pStatus());
  afterEach(() => resetP2pStatus());

  it("stable digest is identical while hormones, peers, dates, channel and memory change", () => {
    const a = buildPrompt({
      dopamine: 0.71,
      peerCount: 3,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY\n*Last dream: 2026-09-19*",
    });
    const b = buildPrompt({
      dopamine: 0.28,
      peerCount: 9,
      factDate: "2026-09-20",
      channel: "discord",
      memory: "# MEMORY\n*Last dream: 2026-09-19*",
    });
    const da = digestSystemPromptHalves(a);
    const db = digestSystemPromptHalves(b);
    expect(da.boundaryFound).toBe(true);
    expect(db.boundaryFound).toBe(true);
    expect(da.stableDigest).toBe(db.stableDigest);
    expect(da.volatileDigest).not.toBe(db.volatileDigest);
  });

  it("puts only session-stable sections above the boundary and volatile ones below", () => {
    const prompt = buildPrompt({
      dopamine: 0.5,
      peerCount: 2,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY",
    });
    const { stable, volatile } = splitSystemPromptAtBoundary(prompt);
    for (const header of [
      "## Canonical Facts",
      "## /ws/MEMORY.md",
      "## Tooling",
      "## Tool Call Style",
      "## Work Planning",
      "## Workflow Management",
      "## Safety",
      "## Agent Wallet (USDC on Base)",
      "## Bitterbot CLI Quick Reference",
      "## Skills (mandatory)",
      "## Memory System",
      "### Pre-Action Interceptors (PLAN-20)",
      "### Curiosity Engine",
      "### Economic Identity",
      "### Forage (bounty economy)",
      "### Circles (your social graph)",
      "### Memory tools",
      "## Bitterbot Self-Update",
      "## Model Aliases",
      "## Workspace",
      "## Documentation",
      "## Workspace Files (injected)",
      "## Reply Tags",
      "## Messaging",
      "# Project Context",
      "## /ws/GENOME.md",
      "## /ws/PROTOCOLS.md",
      "## /ws/TOOLS.md",
      "## Silent Replies",
      "## Heartbeats",
    ]) {
      expect(stable, header).toContain(header);
      expect(volatile ?? "", header).not.toContain(`\n${header}\n`);
    }
    for (const header of [
      "## Endocrine State",
      "## Reactions",
      "## Current Date & Time",
      "# Project Context (live)",
      "## /ws/memory/scratch.md",
      "## Runtime",
    ]) {
      expect(volatile ?? "", header).toContain(header);
      expect(stable, header).not.toContain(header);
    }
    // No live numbers or dates in the cached half.
    expect(stable).not.toMatch(/Currently connected to \d+/);
    expect(stable).not.toMatch(/Network health: \d+%/);
    expect(stable).not.toContain("2026-09-19");
    expect(stable).not.toMatch(/channel=/);
    // Volatile half keeps them, plus the runtime line.
    expect(volatile).toContain("channel=telegram");
    expect(volatile).toContain("Dopamine: 0.5 elevated (DOMINANT)");
  });

  it("renders the Tooling section as one sorted names-only line, no summaries", () => {
    const prompt = buildPrompt({
      dopamine: 0.5,
      peerCount: 2,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY",
    });
    expect(prompt).toContain("Tools: circles, exec, gateway, memory_search, read, wallet, write");
    expect(prompt).not.toContain("Read file contents");
    expect(prompt).not.toContain("- read:");
  });

  it("omits the boundary when there is nothing volatile and in none mode", () => {
    const bare = buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot", promptMode: "none" });
    expect(bare).not.toContain(CACHE_BOUNDARY_MARKER);
    const assembled = assembleSystemPromptWithBoundary({ stable: ["a", "", "b"], volatile: [] });
    expect(assembled).toBe("a\nb");
  });

  it("the Runtime line always sits below the boundary (the minimal prompt has one too)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      promptMode: "minimal",
      runtimeInfo: { host: "h", model: "m" },
    });
    const halves = splitSystemPromptAtBoundary(prompt);
    expect(halves.found).toBe(true);
    expect(halves.volatile).toContain("Runtime:");
    expect(halves.stable).not.toContain("Runtime:");
  });
});

describe("normalizeStablePromptText", () => {
  it("normalizes CRLF, trailing whitespace and blank-line runs", () => {
    const out = normalizeStablePromptText("a  \r\nb\t\r\n\r\n\r\n\r\nc \n");
    expect(out).toBe("a\nb\n\nc");
  });
});

describe("digestToolDefinitions", () => {
  it("is order-independent (sorted by name) and content-sensitive", () => {
    const a = digestToolDefinitions([
      { name: "write", description: "w", parameters: { type: "object" } },
      { name: "read", description: "r", parameters: { type: "object" } },
    ]);
    const b = digestToolDefinitions([
      { name: "read", description: "r", parameters: { type: "object" } },
      { name: "write", description: "w", parameters: { type: "object" } },
    ]);
    const c = digestToolDefinitions([
      { name: "read", description: "r2", parameters: { type: "object" } },
      { name: "write", description: "w", parameters: { type: "object" } },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(digestToolDefinitions([])).toBeUndefined();
  });
});

describe("hormone bucketing", () => {
  it("rounds to one decimal and labels the level", () => {
    expect(bucketHormone(0.7449)).toBe(0.7);
    expect(bucketHormone(0.75)).toBe(0.8);
    expect(bucketHormone(Number.NaN)).toBe(0);
    expect(hormoneLevelLabel(0.1)).toBe("low");
    expect(hormoneLevelLabel(0.3)).toBe("moderate");
    expect(hormoneLevelLabel(0.6)).toBe("elevated");
    expect(hormoneLevelLabel(0.9)).toBe("high");
  });
});

describe("MEMORY.md above the boundary", () => {
  it("a dream rewrite of MEMORY.md moves the stable digest (once per cycle), not per turn", () => {
    const a = buildPrompt({
      dopamine: 0.5,
      peerCount: 2,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY\nv1",
    });
    const b = buildPrompt({
      dopamine: 0.5,
      peerCount: 2,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY\nv2",
    });
    expect(digestSystemPromptHalves(a).stableDigest).not.toBe(
      digestSystemPromptHalves(b).stableDigest,
    );
  });
});
