/**
 * PLAN-52 Phase 5: tests of the owned skill loader that do not need
 * pi-coding-agent. `skill-loader.differential.test.ts` compares the same code
 * with pi and goes away with that dependency; this file stays.
 *
 * The prompt golden in `__snapshots__` is the exact skills block of the system
 * prompt. It was recorded while the differential tests were green, so it
 * equals what pi 0.73.1 produces. A change to it changes the prompt cache
 * prefix for every user.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSkillIgnoreMatcher } from "./skill-ignore.js";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
  type SkillDiagnostic,
} from "./skill-loader.js";

let tmpRoot = "";

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function fm(fields: string[], body = "Body.\n"): string {
  return `---\n${fields.join("\n")}\n---\n\n${body}`;
}

function skillFile(root: string, dir: string, description = `Skill in ${dir}.`): void {
  write(
    root,
    `${dir}/SKILL.md`,
    fm([`name: ${path.basename(dir)}`, `description: ${description}`]),
  );
}

function sorted(values: readonly string[]): string[] {
  const out = [...values];
  out.sort();
  return out;
}

/** Discovery order is the OS's directory order, so tests compare sorted names. */
function names(skills: readonly Skill[]): string[] {
  return sorted(skills.map((s) => s.name));
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Diagnostic messages per file (path relative to the root, "/" separated). */
function messagesByFile(
  root: string,
  diagnostics: readonly SkillDiagnostic[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of diagnostics) {
    (out[rel(root, d.path)] ??= []).push(d.message);
  }
  return out;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-skill-loader-"));
});

afterAll(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("loadSkillsFromDir", () => {
  let root = "";

  beforeAll(() => {
    root = path.join(tmpRoot, "skills-root");
    skillFile(root, "alpha", "Alpha skill.");
    skillFile(root, "alpha/nested");
    write(root, "alpha/notes.md", fm(["name: notes", "description: Inside a skill."]));
    skillFile(root, "group/beta", "Beta skill, two levels down.");
    write(root, "group/readme.md", fm(["name: readme", "description: Not in the root."]));
    write(root, "top-level.md", fm(["name: top-level", "description: A root markdown skill."]));
    write(root, "plain.md", "# No frontmatter\n");
    write(root, "notes.txt", "not markdown\n");
    skillFile(root, "node_modules/dep");
    skillFile(root, ".hidden/secret");
    write(
      root,
      "quiet/SKILL.md",
      fm(["name: quiet", "description: Only on request.", "disable-model-invocation: true"]),
    );
  });

  it("finds SKILL.md directories at any depth and markdown files in the root only", () => {
    const { skills } = loadSkillsFromDir({ dir: root, source: "bitterbot-workspace" });
    expect(names(skills)).toEqual(["alpha", "beta", "quiet", "top-level"]);
  });

  it("returns the full Skill shape", () => {
    const { skills } = loadSkillsFromDir({ dir: root, source: "bitterbot-workspace" });
    const baseDir = path.join(root, "alpha");
    const filePath = path.join(baseDir, "SKILL.md");
    expect(skills.find((s) => s.name === "alpha")).toStrictEqual({
      name: "alpha",
      description: "Alpha skill.",
      filePath,
      baseDir,
      sourceInfo: {
        path: filePath,
        source: "bitterbot-workspace",
        scope: "temporary",
        origin: "top-level",
        baseDir,
      },
      disableModelInvocation: false,
    });
    expect(skills.find((s) => s.name === "quiet")?.disableModelInvocation).toBe(true);
    // A root markdown file is its own skill file; its base dir is the root.
    const top = skills.find((s) => s.name === "top-level");
    expect(top?.filePath).toBe(path.join(root, "top-level.md"));
    expect(top?.baseDir).toBe(root);
  });

  it("reports diagnostics for root markdown files", () => {
    const { diagnostics } = loadSkillsFromDir({ dir: root, source: "bitterbot-workspace" });
    expect(messagesByFile(root, diagnostics)).toEqual({
      "top-level.md": ['name "top-level" does not match parent directory "skills-root"'],
      "plain.md": ["description is required"],
    });
    expect(diagnostics.every((d) => d.type === "warning")).toBe(true);
  });

  it("treats a root with SKILL.md as one skill and scans nothing else", () => {
    const dir = path.join(tmpRoot, "single");
    skillFile(dir, "child");
    write(dir, "SKILL.md", fm(["name: single", "description: The root is the skill."]));
    write(dir, "other.md", fm(["name: other", "description: Ignored."]));
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "x" });
    expect(names(skills)).toEqual(["single"]);
    expect(diagnostics).toEqual([]);
  });

  it("stops at a SKILL.md that fails to load", () => {
    const dir = path.join(tmpRoot, "single-bad");
    skillFile(dir, "child");
    write(dir, "SKILL.md", "# no frontmatter\n");
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "x" });
    expect(skills).toEqual([]);
    expect(messagesByFile(dir, diagnostics)).toEqual({ "SKILL.md": ["description is required"] });
  });

  it("validates names and descriptions, loading the skill unless the description is missing", () => {
    const dir = path.join(tmpRoot, "validation");
    const longName = "n".repeat(65);
    skillFile(dir, "good");
    skillFile(dir, "Bad_Name");
    skillFile(dir, "-edge-");
    skillFile(dir, "dou--ble");
    skillFile(dir, longName);
    write(dir, "mismatch/SKILL.md", fm(["name: other", "description: Mismatch."]));
    write(dir, "no-name/SKILL.md", fm(["description: Name comes from the directory."]));
    write(dir, "long-desc/SKILL.md", fm(["name: long-desc", `description: ${"d".repeat(1025)}`]));
    write(dir, "max-desc/SKILL.md", fm(["name: max-desc", `description: ${"d".repeat(1024)}`]));
    write(dir, "no-desc/SKILL.md", fm(["name: no-desc"]));
    write(dir, "blank-desc/SKILL.md", fm(["name: blank-desc", 'description: "  "']));
    write(dir, "num-desc/SKILL.md", fm(["name: num-desc", "description: 42"]));
    write(dir, "num-name/SKILL.md", fm(["name: 42", "description: Numeric name."]));
    write(dir, "bad-yaml/SKILL.md", "---\nname: [unclosed\ndescription: x\n---\n");
    write(dir, "padded/SKILL.md", fm(["name: padded", 'description: "  padded  "']));
    write(
      dir,
      "string-flag/SKILL.md",
      fm(["name: string-flag", "description: Flag.", 'disable-model-invocation: "true"']),
    );

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "x" });
    expect(names(skills)).toEqual(
      sorted([
        "-edge-",
        "Bad_Name",
        "dou--ble",
        "good",
        "long-desc",
        "max-desc",
        longName,
        "no-name",
        "other",
        "padded",
        "string-flag",
      ]),
    );
    expect(skills.find((s) => s.name === "padded")?.description).toBe("  padded  ");
    expect(skills.find((s) => s.name === "string-flag")?.disableModelInvocation).toBe(false);

    const byFile = messagesByFile(dir, diagnostics);
    const yamlMessages = byFile["bad-yaml/SKILL.md"];
    delete byFile["bad-yaml/SKILL.md"];
    expect(yamlMessages).toHaveLength(1);
    expect(byFile).toEqual({
      "Bad_Name/SKILL.md": [
        "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
      ],
      "-edge-/SKILL.md": ["name must not start or end with a hyphen"],
      "dou--ble/SKILL.md": ["name must not contain consecutive hyphens"],
      [`${longName}/SKILL.md`]: ["name exceeds 64 characters (65)"],
      "mismatch/SKILL.md": ['name "other" does not match parent directory "mismatch"'],
      "long-desc/SKILL.md": ["description exceeds 1024 characters (1025)"],
      "no-desc/SKILL.md": ["description is required"],
      "blank-desc/SKILL.md": ["description is required"],
      "num-desc/SKILL.md": ["description.trim is not a function"],
      "num-name/SKILL.md": ["name.startsWith is not a function"],
    });
  });

  it("honours .gitignore, .ignore and .fdignore, with nested files scoped to their directory", () => {
    const dir = path.join(tmpRoot, "ignores");
    write(dir, ".gitignore", "# comment\nignored/\n*.skip.md\n!keep.skip.md\n");
    write(dir, ".ignore", "from-ignore\n");
    write(dir, ".fdignore", "from-fdignore\n");
    write(dir, "group/.gitignore", "local\n");
    skillFile(dir, "kept");
    skillFile(dir, "ignored/inner");
    skillFile(dir, "from-ignore");
    skillFile(dir, "from-fdignore");
    skillFile(dir, "group/local");
    skillFile(dir, "group/deeper/local");
    skillFile(dir, "group/visible");
    write(dir, "drop.skip.md", fm(["name: ignores", "description: Dropped."]));
    write(dir, "keep.skip.md", fm(["name: ignores", "description: Kept by negation."]));

    const { skills } = loadSkillsFromDir({ dir, source: "x" });
    expect(sorted(skills.map((s) => rel(dir, s.filePath)))).toEqual([
      // A pattern from group/.gitignore only applies directly inside group/.
      "group/deeper/local/SKILL.md",
      "group/visible/SKILL.md",
      "keep.skip.md",
      "kept/SKILL.md",
    ]);
  });

  it.skipIf(process.platform === "win32")("follows symlinks and skips broken ones", () => {
    const dir = path.join(tmpRoot, "links");
    const ext = path.join(tmpRoot, "links-external");
    skillFile(ext, "target-skill");
    write(ext, "file.md", fm(["name: links", "description: Linked file."]));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(ext, "target-skill"), path.join(dir, "target-skill"), "dir");
    fs.symlinkSync(path.join(ext, "file.md"), path.join(dir, "linked.md"), "file");
    fs.symlinkSync(path.join(ext, "missing"), path.join(dir, "broken"), "dir");
    fs.symlinkSync(path.join(ext, "missing.md"), path.join(dir, "broken.md"), "file");

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "x" });
    // Paths are reported through the link, not resolved.
    expect(sorted(skills.map((s) => rel(dir, s.filePath)))).toEqual([
      "linked.md",
      "target-skill/SKILL.md",
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("returns both skills when two directories use the same name", () => {
    const dir = path.join(tmpRoot, "duplicates");
    skillFile(dir, "a/shared");
    skillFile(dir, "b/shared");
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "x" });
    expect(names(skills)).toEqual(["shared", "shared"]);
    expect(diagnostics).toEqual([]);
  });

  it("maps the user, project and path sources to a local source with a scope", () => {
    const dir = path.join(tmpRoot, "sources");
    skillFile(dir, "one");
    const info = (source: string) => loadSkillsFromDir({ dir, source }).skills[0]?.sourceInfo;
    expect(info("user")).toMatchObject({ source: "local", scope: "user" });
    expect(info("project")).toMatchObject({ source: "local", scope: "project" });
    expect(info("path")).toMatchObject({ source: "local", scope: "temporary" });
    expect(info("bitterbot-bundled")).toMatchObject({
      source: "bitterbot-bundled",
      scope: "temporary",
      origin: "top-level",
    });
  });

  it("returns nothing for a missing directory or a file", () => {
    const file = path.join(tmpRoot, "a-file.md");
    fs.writeFileSync(file, fm(["name: a-file", "description: A file."]));
    for (const dir of [path.join(tmpRoot, "missing"), file]) {
      expect(loadSkillsFromDir({ dir, source: "x" })).toEqual({ skills: [], diagnostics: [] });
    }
  });
});

describe("formatSkillsForPrompt", () => {
  const skill = (overrides: Partial<Skill>): Skill => ({
    name: "demo",
    description: "Demo skill.",
    filePath: "/skills/demo/SKILL.md",
    baseDir: "/skills/demo",
    sourceInfo: {
      path: "/skills/demo/SKILL.md",
      source: "bitterbot-bundled",
      scope: "temporary",
      origin: "top-level",
      baseDir: "/skills/demo",
    },
    disableModelInvocation: false,
    ...overrides,
  });

  it("returns an empty string when no skill is visible", () => {
    expect(formatSkillsForPrompt([])).toBe("");
    expect(formatSkillsForPrompt([skill({ disableModelInvocation: true })])).toBe("");
  });

  it("produces the exact block for one skill", () => {
    expect(formatSkillsForPrompt([skill({})])).toBe(
      [
        "",
        "",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Demo skill.</description>",
        "    <location>/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    );
  });

  it("leaves out skills with model invocation disabled", () => {
    const prompt = formatSkillsForPrompt([
      skill({ name: "shown" }),
      skill({ name: "hidden", disableModelInvocation: true }),
    ]);
    expect(prompt).toContain("<name>shown</name>");
    expect(prompt).not.toContain("hidden");
  });

  it("escapes XML characters in name, description and location", () => {
    const prompt = formatSkillsForPrompt([
      skill({
        name: "a&b",
        description: `1 < 2 > 0 "q" 'a'`,
        filePath: "/p/<x>/SKILL.md",
      }),
    ]);
    expect(prompt).toContain("<name>a&amp;b</name>");
    expect(prompt).toContain(
      "<description>1 &lt; 2 &gt; 0 &quot;q&quot; &apos;a&apos;</description>",
    );
    expect(prompt).toContain("<location>/p/&lt;x&gt;/SKILL.md</location>");
  });

  it("matches the golden prompt for a small tree loaded from disk", () => {
    const dir = path.join(tmpRoot, "golden");
    skillFile(dir, "calendar", "Read and create calendar events.");
    skillFile(dir, "tools/pdf-extract", 'Extract text & tables from PDFs ("scanned" too).');
    write(
      dir,
      "tools/weather/SKILL.md",
      fm(["name: weather", "description: |", "  Current weather.", "  Forecasts for <city>."]),
    );
    write(
      dir,
      "internal/SKILL.md",
      fm(["name: internal", "description: Hidden.", "disable-model-invocation: true"]),
    );
    write(dir, "quick-note.md", fm(["name: quick-note", "description: A root markdown skill."]));

    const { skills } = loadSkillsFromDir({ dir, source: "bitterbot-workspace" });
    // Fixed order and fixed POSIX paths, so the golden does not depend on the
    // temp directory or on the OS's directory order.
    const byName = new Map(skills.map((s) => [s.name, s]));
    const stable = names(skills).flatMap((name) => {
      const s = byName.get(name);
      return s
        ? [
            {
              ...s,
              filePath: `/skills/${rel(dir, s.filePath)}`,
              baseDir: `/skills/${rel(dir, s.baseDir)}`,
            },
          ]
        : [];
    });
    expect(stable.map((s) => s.name)).toEqual([
      "calendar",
      "internal",
      "pdf-extract",
      "quick-note",
      "weather",
    ]);
    expect(formatSkillsForPrompt(stable)).toMatchSnapshot();
  });
});

describe("SkillIgnoreMatcher", () => {
  it("matches a directory pattern against the directory and everything inside", () => {
    const ig = createSkillIgnoreMatcher().add(["build/"]);
    expect(ig.ignores("build/")).toBe(true);
    expect(ig.ignores("build/skill/SKILL.md")).toBe(true);
    expect(ig.ignores("src/build/")).toBe(true);
    // Without the trailing slash the path is a file, which `build/` does not match.
    expect(ig.ignores("build")).toBe(false);
  });

  it("anchors a pattern that has a slash in the middle", () => {
    const ig = createSkillIgnoreMatcher().add(["group/local"]);
    expect(ig.ignores("group/local/")).toBe(true);
    expect(ig.ignores("group/deeper/local/")).toBe(false);
    expect(ig.ignores("other/group/local/")).toBe(false);
  });

  it("supports wildcards, negation and case-insensitive matching", () => {
    const ig = createSkillIgnoreMatcher().add(["*.skip.md", "!keep.skip.md", "**/deep", "a?c"]);
    expect(ig.ignores("drop.skip.md")).toBe(true);
    expect(ig.ignores("DROP.SKIP.MD")).toBe(true);
    expect(ig.ignores("keep.skip.md")).toBe(false);
    expect(ig.ignores("x/y/deep/")).toBe(true);
    expect(ig.ignores("abc")).toBe(true);
    expect(ig.ignores("a/c")).toBe(false);
  });

  it("does not re-include a path below an ignored directory", () => {
    const ig = createSkillIgnoreMatcher().add(["out/", "!out/keep/"]);
    expect(ig.ignores("out/keep/")).toBe(true);
  });

  it("skips comments and blank lines, and sees rules added later", () => {
    const ig = createSkillIgnoreMatcher().add(["# comment", "", "   "]);
    expect(ig.ignores("comment")).toBe(false);
    expect(ig.ignores("later/")).toBe(false);
    ig.add(["later"]);
    expect(ig.ignores("later/")).toBe(true);
  });

  it("rejects paths that are empty or not relative", () => {
    const ig = createSkillIgnoreMatcher();
    expect(() => ig.ignores("")).toThrow(TypeError);
    expect(() => ig.ignores("../a")).toThrow(RangeError);
    expect(() => ig.ignores("/a")).toThrow(RangeError);
    expect(() => ig.ignores("./a")).toThrow(RangeError);
  });

  it("throws from ignores(), not add(), for a pattern that is not a valid expression", () => {
    const ig = createSkillIgnoreMatcher();
    expect(() => ig.add(["a\\\\["])).not.toThrow();
    expect(() => ig.ignores("a")).toThrow(SyntaxError);
    expect(() => ig.ignores("a")).toThrow(SyntaxError);
  });
});
