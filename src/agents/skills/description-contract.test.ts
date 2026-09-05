import { describe, expect, it } from "vitest";
import {
  checkDescriptionContract,
  checkSkillDescriptionContract,
  DESCRIPTION_MAX_CHARS,
  describeContractIssues,
  rewriteDescriptionLine,
} from "./description-contract.js";

const GOOD =
  "Bound every curl in exec with --max-time when the task runs curl; not for commands that make no network calls.";

describe("checkDescriptionContract (PLAN-44 Phase 4a)", () => {
  it("accepts a description that names the trigger and the scope-out", () => {
    expect(
      checkDescriptionContract({
        skillName: "curl-timeout-guard",
        frontmatterName: "curl-timeout-guard",
        description: GOOD,
      }),
    ).toEqual([]);
  });

  it("reports each violation by name", () => {
    expect(
      checkDescriptionContract({
        skillName: "public-apis-alt",
        frontmatterName: "public-apis/public-apis",
        description: "A collective list of free APIs",
      }),
    ).toEqual([
      "name-mismatch",
      "variant-suffix",
      "too-short",
      "no-trigger-clause",
      "no-scope-out-clause",
    ]);
    expect(
      checkDescriptionContract({
        skillName: "x",
        frontmatterName: "x",
        description: `😎 Awesome lists when you need them; not for https://example.com [NOTE: pull requests are disabled]`,
      }),
    ).toContain("noise");
    expect(
      checkDescriptionContract({
        skillName: "x",
        frontmatterName: "x",
        description: `${GOOD} ${"x".repeat(DESCRIPTION_MAX_CHARS)}`,
      }),
    ).toContain("too-long");
  });

  it("reads the frontmatter of a whole SKILL.md and renders issues for humans", () => {
    const md = `---\nname: other\ndescription: short\n---\nbody\n`;
    const issues = checkSkillDescriptionContract("curl-timeout-guard", md);
    expect(issues).toContain("name-mismatch");
    expect(describeContractIssues(issues)).toContain("frontmatter name must equal the skill name");
  });
});

describe("rewriteDescriptionLine", () => {
  it("replaces the description line in place, quoting YAML-hostile values", () => {
    const md = `---\nname: a\ndescription: old one\nversion: 1\n---\n\n# body\n`;
    const out = rewriteDescriptionLine(md, "Use when X: Y; not for Z");
    expect(out).toBe(
      `---\nname: a\ndescription: "Use when X: Y; not for Z"\nversion: 1\n---\n\n# body\n`,
    );
    expect(rewriteDescriptionLine(md, "plain when; not")).toContain(
      "\ndescription: plain when; not\n",
    );
  });

  it("inserts the line when absent and leaves non-frontmatter content alone", () => {
    expect(rewriteDescriptionLine(`---\nname: a\n---\nbody`, "d")).toBe(
      `---\nname: a\ndescription: d\n---\nbody`,
    );
    expect(rewriteDescriptionLine("no frontmatter", "d")).toBe("no frontmatter");
  });
});
