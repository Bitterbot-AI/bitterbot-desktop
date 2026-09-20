/**
 * Token-efficiency W4: the cache boundary in the system prompt.
 *
 * Contract: everything above `<!-- BITTERBOT_CACHE_BOUNDARY -->` is
 * byte-identical across turns of one session, however hormones, peer
 * counts, canonical-fact dates, runtime channel or working memory move.
 */
import fs from "node:fs";
import path from "node:path";
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

const TEMPLATES_DIR = path.resolve(__dirname, "../../docs/reference/templates");

/** Workspace template without its docs frontmatter, as a fresh install ships it. */
function readTemplate(name: string): string {
  const raw = fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/** chars / 2.7 tracks Anthropic's count_tokens on this prompt (40,942 chars = 15,220 tokens on 2026-09-20). */
const estimateTokens = (text: string): number => Math.round(text.length / 2.7);
export const STABLE_HALF_TOKEN_BUDGET = 9_000;

/**
 * Production-shaped fixture: a stock install's GENOME/PROTOCOLS/TOOLS/MEMORY
 * templates, 24 bundled skills at full description length, a 26-fact
 * canonical block in the W6 `- [key] value` shape, wallet + circles + every
 * memory tool, and a P2P-connected node.
 */
function buildProductionShapedPrompt(
  overrides: {
    sessionContext?: { group?: boolean; githubAvailable?: boolean };
  } = {},
) {
  const skillBlocks = Array.from({ length: 24 }, (_, i) =>
    [
      "  <skill>",
      `    <name>skill-${i}</name>`,
      `    <description>Use when the user asks about topic number ${i}, its setup, its failure modes or its reporting; not for adjacent topics handled by other skills.</description>`,
      `    <location>/opt/bitterbot/skills/skill-${i}/SKILL.md</location>`,
      "  </skill>",
    ].join("\n"),
  );
  const facts = Array.from(
    { length: 26 },
    (_, i) => `- [category.key_${i}] a canonical value of realistic length number ${i}`,
  );
  return buildPrompt({
    dopamine: 0.5,
    peerCount: 2,
    factDate: "2026-09-19",
    channel: "telegram",
    memory: readTemplate("MEMORY.md"),
    contextFiles: [
      { path: "/ws/GENOME.md", content: readTemplate("GENOME.md") },
      { path: "/ws/PROTOCOLS.md", content: readTemplate("PROTOCOLS.md") },
      { path: "/ws/TOOLS.md", content: readTemplate("TOOLS.md") },
      { path: "/ws/MEMORY.md", content: readTemplate("MEMORY.md") },
      { path: "/ws/memory/scratch.md", content: "- note" },
    ],
    skillsPrompt: ["<available_skills>", ...skillBlocks, "</available_skills>"].join("\n"),
    canonicalFacts: ["## Canonical Facts", "Ground truth.", ...facts].join("\n"),
    sessionContext: overrides.sessionContext,
  });
}

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
  contextFiles?: Array<{ path: string; content: string }>;
  skillsPrompt?: string;
  canonicalFacts?: string;
  sessionContext?: { group?: boolean; githubAvailable?: boolean };
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
    toolNames: [
      "write",
      "read",
      "exec",
      "memory_search",
      "memory_get",
      "memory_status",
      "working_memory_note",
      "gateway",
      "wallet",
      "circles",
      "message",
    ],
    toolSummaries: { read: "ignored" },
    skillsPrompt: variant.skillsPrompt ?? SKILLS,
    docsPath: "/tmp/bitterbot/docs",
    userTimezone: "Europe/Madrid",
    modelAliasLines: ["- opus: anthropic/claude-opus-4-8"],
    heartbeatPrompt: "Read HEARTBEAT.md if it exists.",
    sessionContext: variant.sessionContext,
    contextFiles: variant.contextFiles ?? [
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
    canonicalFacts:
      variant.canonicalFacts ??
      stripCanonicalFactMetadata(
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
      "### Memory tools",
      "### Rules",
      "### Economic Identity",
      "### Circles",
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
    expect(prompt).toContain(
      "Tools: circles, exec, gateway, memory_get, memory_search, memory_status, message, read, wallet, working_memory_note, write",
    );
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

describe("stable-half token budget (token-efficiency W6)", () => {
  beforeEach(() => resetP2pStatus());
  afterEach(() => resetP2pStatus());

  it("a production-shaped prompt keeps the cached half under the budget", () => {
    const { stable } = splitSystemPromptAtBoundary(buildProductionShapedPrompt());
    expect(estimateTokens(stable)).toBeLessThan(STABLE_HALF_TOKEN_BUDGET);
  });

  it("the memory index stays a short index; economy + circles fragments stay compact", () => {
    const { stable } = splitSystemPromptAtBoundary(buildProductionShapedPrompt());
    const start = stable.indexOf("## Memory System");
    const economy = stable.indexOf("### Economic Identity", start);
    const end = stable.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(economy).toBeGreaterThan(start);
    expect(estimateTokens(stable.slice(start, economy))).toBeLessThanOrEqual(600);
    expect(estimateTokens(stable.slice(economy, end))).toBeLessThanOrEqual(520);
    // Long-form guidance is reachable through the bundled skills.
    for (const name of [
      "memory-architecture",
      "working-memory-protocol",
      "curiosity-loop",
      "pre-action-interceptors",
      "forage-economy",
      "circles-protocol",
    ]) {
      expect(stable, name).toContain(`\`${name}\``);
    }
    // ...and is no longer inlined.
    expect(stable).not.toContain("### Pre-Action Interceptors");
    expect(stable).not.toContain("Ebbinghaus importance recalculation");
    expect(stable).not.toContain("### Working Memory (MEMORY.md as Recursive State Vector)");
  });

  it("no `#`/`##`/`###` heading appears twice in the stable half", () => {
    const { stable } = splitSystemPromptAtBoundary(buildProductionShapedPrompt());
    const seen = new Map<string, number>();
    let inFence = false;
    for (const line of stable.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !/^#{1,3} /.test(line)) {
        continue;
      }
      seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
    expect(duplicates).toEqual([]);
    // The two historical duplicates: built-in Heartbeats/Safety vs PROTOCOLS.md's.
    expect(stable.split("\n## Heartbeats\n").length).toBe(2);
    expect(stable.split("\n## Safety\n").length).toBe(2);
  });

  it("workspace-file headings nest under the file heading (demoted one level)", () => {
    const { stable } = splitSystemPromptAtBoundary(buildProductionShapedPrompt());
    expect(stable).toContain("## /ws/PROTOCOLS.md");
    expect(stable).toContain("\n### External vs Internal\n");
    expect(stable).not.toContain("\n## External vs Internal\n");
    expect(stable).toContain("\n### Hormonal Homeostasis\n");
  });

  it("group-chat, heartbeat and GitHub template sections are session-conditional", () => {
    const direct = splitSystemPromptAtBoundary(buildProductionShapedPrompt()).stable;
    expect(direct).not.toContain("### Group Chats");
    expect(direct).not.toContain("### Know When to Speak");
    expect(direct).not.toContain("### Heartbeat vs Cron");
    expect(direct).toContain(
      "Sections omitted for this session (read the file for them): PROTOCOLS.md: Group Chats, Heartbeats",
    );
    const group = splitSystemPromptAtBoundary(
      buildProductionShapedPrompt({ sessionContext: { group: true } }),
    ).stable;
    expect(group).toContain("### Group Chats");
    expect(group).toContain("### Know When to Speak");
    expect(group).not.toContain("### Heartbeat vs Cron");
    // The built-in ack contract is always present.
    expect(direct).toContain("## Heartbeats");
    expect(direct).toContain("HEARTBEAT_OK");
  });

  it("inline-button availability renders below the boundary (it follows the triggering channel)", () => {
    const prompt = buildPrompt({
      dopamine: 0.5,
      peerCount: 2,
      factDate: "2026-09-19",
      channel: "telegram",
      memory: "# MEMORY",
    });
    const { stable, volatile } = splitSystemPromptAtBoundary(prompt);
    expect(stable).not.toContain("Inline buttons");
    expect(volatile).toContain("Inline buttons supported");
  });
});
