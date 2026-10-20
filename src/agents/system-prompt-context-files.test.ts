import { describe, expect, it } from "vitest";
import {
  demoteHeadings,
  dropSections,
  prepareContextFile,
  renderOmittedSectionsLine,
} from "./system-prompt-context-files.js";

const PROTOCOLS = [
  "# Protocols",
  "",
  "## Safety",
  "- trash > rm",
  "",
  "## Group Chats",
  "Think before you speak.",
  "",
  "### Know When to Speak",
  "- Directly mentioned",
  "",
  "## Heartbeats",
  "Rotate checks.",
  "",
  "### Heartbeat vs Cron",
  "Use cron when exact timing matters.",
  "",
  "## Tools",
  "```bash",
  "# a comment inside a fence stays put",
  "## and so does this",
  "```",
  "Keep local notes in TOOLS.md.",
].join("\n");

describe("demoteHeadings", () => {
  it("demotes every heading by one level, fence-aware, CRLF-safe", () => {
    const out = demoteHeadings(PROTOCOLS.replace(/\n/g, "\r\n"));
    expect(out.startsWith("## Protocols\n")).toBe(true);
    expect(out).toContain("\n### Safety\n");
    expect(out).toContain("\n#### Know When to Speak\n");
    expect(out).toContain("\n# a comment inside a fence stays put\n");
    expect(out).toContain("\n## and so does this\n");
    expect(out).not.toContain("\r");
  });

  it("caps at six levels", () => {
    expect(demoteHeadings("###### deep")).toBe("###### deep");
  });
});

describe("dropSections", () => {
  it("removes a section up to the next heading of the same or higher level", () => {
    const { content, dropped } = dropSections(PROTOCOLS, ["group chats", "Heartbeats"]);
    expect(dropped).toEqual(["Group Chats", "Heartbeats"]);
    expect(content).not.toContain("Group Chats");
    expect(content).not.toContain("Know When to Speak");
    expect(content).not.toContain("Heartbeat vs Cron");
    expect(content).toContain("## Safety\n- trash > rm");
    expect(content).toContain("## Tools");
    expect(content).toContain("Keep local notes in TOOLS.md.");
  });

  it("reports nothing dropped when the heading is absent", () => {
    const { content, dropped } = dropSections(PROTOCOLS, ["GitHub"]);
    expect(dropped).toEqual([]);
    expect(content).toBe(PROTOCOLS);
  });
});

describe("prepareContextFile + renderOmittedSectionsLine", () => {
  const direct = { group: false, heartbeat: false, github: false };

  it("applies the session policy per file and lists what was omitted", () => {
    const protocols = prepareContextFile({ path: "/ws/PROTOCOLS.md", content: PROTOCOLS }, direct);
    const tools = prepareContextFile(
      {
        path: "C:\\ws\\TOOLS.md",
        content: "# Tools\n\n## GitHub\n- the repo is x/y\n\n## SSH\n- host",
      },
      direct,
    );
    const genome = prepareContextFile(
      { path: "/ws/GENOME.md", content: "# Genome\n## Safety Axioms" },
      direct,
    );
    expect(protocols.omitted).toEqual(["Group Chats", "Heartbeats"]);
    expect(protocols.content).toContain("### Safety");
    expect(tools.omitted).toEqual(["GitHub"]);
    expect(tools.content).toContain("### SSH");
    expect(tools.content).not.toContain("the repo is x/y");
    expect(genome.omitted).toEqual([]);
    expect(genome.content).toBe("## Genome\n### Safety Axioms");
    expect(renderOmittedSectionsLine([protocols, tools, genome])).toBe(
      "Sections omitted for this session (read the file for them): PROTOCOLS.md: Group Chats, Heartbeats; TOOLS.md: GitHub.",
    );
  });

  it("keeps the sections when the policy says the session needs them", () => {
    const file = prepareContextFile(
      { path: "/ws/PROTOCOLS.md", content: PROTOCOLS },
      { group: true, heartbeat: true, github: true },
    );
    expect(file.omitted).toEqual([]);
    expect(file.content).toContain("### Group Chats");
    expect(file.content).toContain("### Heartbeats");
    expect(renderOmittedSectionsLine([file])).toBeUndefined();
  });
});
