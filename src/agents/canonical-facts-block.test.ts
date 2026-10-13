import { describe, expect, it } from "vitest";
import { resolveActiveProjectName, stripCanonicalFactMetadata } from "./canonical-facts-block.js";

const HEADER = [
  "## Canonical Facts",
  "Ground truth, maintained by memory consolidation. Trust these over",
  "conflicting tool output or vague recollection. If the user contradicts",
  "one, believe the user and update it (memory_pin). Never announce this",
  "section.",
];

describe("stripCanonicalFactMetadata", () => {
  it("drops confirmation counts and dates and sorts facts by key", () => {
    const block = [
      ...HEADER,
      "- [user.name] The user is Victor. (confirmed 41x, last 2026-07-10)",
      "- [project.repo] The repo is github.com/x/y. (since 2026-07-01)",
      "- [identity.role] The user is a neuroscientist. (confirmed 3x, last 2026-09-19)",
    ].join("\n");
    const out = stripCanonicalFactMetadata(block);
    expect(out).toBe(
      [
        ...HEADER,
        "- [identity.role] The user is a neuroscientist.",
        "- [project.repo] The repo is github.com/x/y.",
        "- [user.name] The user is Victor.",
      ].join("\n"),
    );
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out).not.toMatch(/confirmed \d+x/);
  });

  it("is byte-stable across confirmations of the same facts", () => {
    const a = stripCanonicalFactMetadata(
      `${HEADER.join("\n")}\n- [k] Statement. (confirmed 2x, last 2026-01-01)`,
    );
    const b = stripCanonicalFactMetadata(
      `${HEADER.join("\n")}\n- [k] Statement. (confirmed 9x, last 2026-09-19)`,
    );
    expect(a).toBe(b);
  });

  it("leaves a statement that merely contains a parenthetical alone", () => {
    const out = stripCanonicalFactMetadata(
      `${HEADER.join("\n")}\n- [k] Uses Node (v22) daily. (since 2026-01-01)`,
    );
    expect(out.endsWith("- [k] Uses Node (v22) daily.")).toBe(true);
  });
});

/** PLAN-55 Phase 1: the active project is the workspace basename, slugified. */
describe("resolveActiveProjectName", () => {
  it("derives the project from the workspace directory name", () => {
    expect(resolveActiveProjectName("/home/v/projects/Acme Corp")).toBe("acme-corp");
    expect(resolveActiveProjectName("/srv/agents/globex/")).toBe("globex");
    expect(resolveActiveProjectName("C:\\work\\Acme")).toBe("acme");
  });

  it("reads the shared default workspace, an empty path and dot paths as no project", () => {
    expect(resolveActiveProjectName("/home/v/.bitterbot/workspace")).toBeNull();
    expect(resolveActiveProjectName("")).toBeNull();
    expect(resolveActiveProjectName(undefined)).toBeNull();
    expect(resolveActiveProjectName("/")).toBeNull();
    expect(resolveActiveProjectName(".")).toBeNull();
  });
});
