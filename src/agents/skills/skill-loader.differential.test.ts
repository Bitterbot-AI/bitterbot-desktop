/**
 * PLAN-52 Phase 5: differential tests, our skill loader vs pi-coding-agent
 * 0.73.1.
 *
 * `loadSkillsFromDir` and `formatSkillsForPrompt` from `skill-loader.ts` run
 * next to pi's exported functions on the same fixture trees. Skills and
 * diagnostics must be deeply equal (and serialize to the same JSON, so key
 * order is equal too) and the formatted prompt must be the same string.
 *
 * The gitignore matcher in `skill-ignore.ts` is compared with the `ignore`
 * package pi uses. This repo does not depend on `ignore` directly, so it is
 * resolved from pi's own dependencies.
 *
 * This file is deleted when the pi-coding-agent dependency goes (PLAN-52
 * Phase 5); `skill-loader.test.ts` holds the tests that stay.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSkillsForPrompt as piFormatSkillsForPrompt,
  loadSkillsFromDir as piLoadSkillsFromDir,
} from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSkillIgnoreMatcher } from "./skill-ignore.js";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "./skill-loader.js";

type PiIgnore = { add(patterns: string[]): PiIgnore; ignores(path: string): boolean };

function loadPiIgnoreFactory(): () => PiIgnore {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const piPackageJson = fs.realpathSync(
    path.resolve(here, "../../../node_modules/@mariozechner/pi-coding-agent/package.json"),
  );
  return createRequire(piPackageJson)("ignore") as () => PiIgnore;
}

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
    fm([`name: ${JSON.stringify(path.basename(dir))}`, `description: ${description}`]),
  );
}

/** Symlinks need privileges on Windows; a tree without them is still compared. */
function trySymlink(target: string, linkPath: string, type: "dir" | "file"): void {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, type);
  } catch {
    // not supported here
  }
}

function buildMainTree(root: string, ext: string): void {
  // Valid skills and the "skill root stops the scan" rule.
  skillFile(root, "valid-skill");
  write(root, "valid-skill/extra.md", fm(["name: extra", "description: Not a root file."]));
  skillFile(root, "valid-skill/nested");
  skillFile(root, "group/deep/deeper/deep-skill");
  write(root, "group/notes.md", fm(["name: notes", "description: Markdown below the root."]));

  // Root-level markdown files.
  write(root, "root-note.md", fm(["name: root-note", "description: Root level markdown skill."]));
  write(root, "root-plain.md", "# Just markdown\n");
  write(root, "README.txt", "not markdown\n");
  skillFile(root, "folder.md");

  // Frontmatter problems.
  write(root, "no-frontmatter/SKILL.md", "# No frontmatter\n");
  write(root, "missing-desc/SKILL.md", fm(["name: missing-desc"]));
  write(root, "blank-desc/SKILL.md", fm(["name: blank-desc", 'description: "   "']));
  write(root, "no-name/SKILL.md", fm(["description: Name falls back to the directory."]));
  write(root, "empty-fm/SKILL.md", "---\n---\n\nBody.\n");
  write(root, "comment-fm/SKILL.md", "---\n# only a comment\n---\n");
  write(root, "scalar-fm/SKILL.md", "---\njust a string\n---\n");
  write(root, "number-fm/SKILL.md", "---\n42\n---\n");
  write(root, "list-fm/SKILL.md", "---\n- a\n- b\n---\n");
  write(root, "unclosed-fm/SKILL.md", "---\nname: unclosed-fm\ndescription: Never closed.\n");
  write(
    root,
    "tight-fm/SKILL.md",
    "---name: tight-fm\ndescription: Opening fence without a newline.\n---\n",
  );
  write(
    root,
    "early-fence/SKILL.md",
    "---\ndescription: |\n  text\n---more\nname: early-fence\n---\n",
  );
  write(root, "bom/SKILL.md", `﻿${fm(["name: bom", "description: Starts with a BOM."])}`);
  write(root, "bad-yaml/SKILL.md", "---\nname: [unclosed\ndescription: x\n---\n");
  write(root, "dup-key/SKILL.md", fm(["name: dup-key", "description: a", "description: b"]));
  write(
    root,
    "crlf/SKILL.md",
    fm(["name: crlf", "description: Windows line endings."]).replace(/\n/g, "\r\n"),
  );
  write(
    root,
    "cr-only/SKILL.md",
    fm(["name: cr-only", "description: Old Mac line endings."]).replace(/\n/g, "\r"),
  );

  // Name validation.
  write(root, "name-mismatch/SKILL.md", fm(["name: other-name", "description: Mismatch."]));
  skillFile(root, "Bad_Name");
  skillFile(root, "-hyphen-");
  skillFile(root, "double--hyphen");
  skillFile(root, "n".repeat(65));
  skillFile(root, "n".repeat(64));
  write(root, "empty-name/SKILL.md", fm(['name: ""', "description: Empty name falls back."]));

  // Description validation.
  write(root, "long-desc/SKILL.md", fm(["name: long-desc", `description: ${"d".repeat(1025)}`]));
  write(root, "max-desc/SKILL.md", fm(["name: max-desc", `description: ${"d".repeat(1024)}`]));
  write(root, "spaced/SKILL.md", fm(["name: spaced", 'description: "  padded  "']));
  write(root, "xml/SKILL.md", fm(["name: xml", `description: 'a < b & "c" > d ''e'''`]));
  write(
    root,
    "multiline/SKILL.md",
    fm(["name: multiline", "description: |", "  Line one.", "  Line two."]),
  );
  write(root, "folded/SKILL.md", fm(["name: folded", "description: >-", "  folded", "  text"]));
  write(root, "unicode/SKILL.md", fm(["name: unicode", 'description: "Résumé 技能 \u{1F680}"']));

  // Non-string field values.
  write(root, "num-desc/SKILL.md", fm(["name: num-desc", "description: 42"]));
  write(root, "bool-desc/SKILL.md", fm(["name: bool-desc", "description: true"]));
  write(root, "list-desc/SKILL.md", fm(["name: list-desc", "description: [a, b]"]));
  write(root, "map-desc/SKILL.md", fm(["name: map-desc", "description: { trim: 1 }"]));
  write(root, "zero-desc/SKILL.md", fm(["name: zero-desc", "description: 0"]));
  write(root, "false-desc/SKILL.md", fm(["name: false-desc", "description: false"]));
  write(root, "null-desc/SKILL.md", fm(["name: null-desc", "description: ~"]));
  write(root, "num-name/SKILL.md", fm(["name: 42", "description: Numeric name."]));
  write(root, "bool-name/SKILL.md", fm(["name: true", "description: Boolean name."]));
  write(root, "list-name/SKILL.md", fm(["name: [a]", "description: List name."]));
  write(root, "map-name/SKILL.md", fm(["name: { startsWith: x }", "description: Map name."]));
  write(root, "num-name-no-desc/SKILL.md", fm(["name: 42"]));
  write(root, "zero-name/SKILL.md", fm(["name: 0", "description: Falsy name falls back."]));

  // disable-model-invocation.
  write(
    root,
    "hidden/SKILL.md",
    fm(["name: hidden", "description: Hidden.", "disable-model-invocation: true"]),
  );
  write(
    root,
    "hidden-string/SKILL.md",
    fm(["name: hidden-string", "description: Not hidden.", 'disable-model-invocation: "true"']),
  );
  write(
    root,
    "hidden-false/SKILL.md",
    fm(["name: hidden-false", "description: Not hidden.", "disable-model-invocation: false"]),
  );

  // Skipped directories.
  skillFile(root, "node_modules/pkg");
  skillFile(root, ".dot/secret");
  skillFile(root, "group/.dot-nested");
  skillFile(root, "group/node_modules/dep");
  fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });

  // Duplicate names.
  skillFile(root, "dup-a/shared");
  skillFile(root, "dup-b/shared");

  // SKILL.md that is a directory.
  skillFile(root, "skillmd-dir/SKILL.md/inner-skill");

  // Ignore files in the root.
  write(
    root,
    ".gitignore",
    [
      "# comment",
      "",
      "ignored-dir/",
      "*.skip.md",
      "!keep.skip.md",
      "/anchored",
      "ign-skill/SKILL.md",
      "\\!bang-dir",
      "  spaced-pattern",
      "**/glob-deep",
      "wild*/",
      "\\#hash-dir",
      "trailing-space   ",
      "renegated",
      "file-pattern-only",
      "ques?ion",
      "[rR]ange-dir",
      "mid/**/leaf",
      "",
    ].join("\n"),
  );
  write(root, ".ignore", "via-ignore/\r\nvia-ignore-crlf\r\n");
  write(root, ".fdignore", "via-fdignore\n");
  skillFile(root, "ignored-dir/x");
  write(root, "one.skip.md", fm(["name: one", "description: Ignored root file."]));
  write(root, "keep.skip.md", fm(["name: keep", "description: Re-included root file."]));
  skillFile(root, "anchored");
  skillFile(root, "group/anchored");
  skillFile(root, "ign-skill");
  skillFile(root, "ign-skill/child");
  skillFile(root, "!bang-dir");
  skillFile(root, "bang-dir");
  skillFile(root, "spaced-pattern");
  skillFile(root, "group/glob-deep");
  skillFile(root, "glob-deep");
  skillFile(root, "wildcard");
  skillFile(root, "#hash-dir");
  skillFile(root, "trailing-space");
  skillFile(root, "renegated");
  skillFile(root, "file-pattern-only");
  skillFile(root, "question");
  skillFile(root, "range-dir");
  skillFile(root, "Range-dir-upper");
  skillFile(root, "mid/leaf");
  skillFile(root, "mid/a/b/leaf");
  skillFile(root, "via-ignore");
  skillFile(root, "via-ignore-crlf");
  skillFile(root, "via-fdignore");
  skillFile(root, "group/via-fdignore");

  // Ignore file in a nested directory (patterns get the directory prefix).
  write(
    root,
    "group/.gitignore",
    [
      "local-only",
      "/rooted-here",
      "!renegated",
      "sub/deep-ignored/",
      "*.md",
      "\\!escaped-bang",
      "",
    ].join("\n"),
  );
  skillFile(root, "group/local-only");
  skillFile(root, "group/x/local-only");
  skillFile(root, "group/rooted-here");
  skillFile(root, "group/x/rooted-here");
  skillFile(root, "group/renegated");
  skillFile(root, "group/sub/deep-ignored");
  skillFile(root, "group/sub/kept");
  skillFile(root, "group/dotmd.md");
  skillFile(root, "group/!escaped-bang");
  // A sibling scanned after `group` still sees the accumulated rules.
  skillFile(root, "zz-later/local-only");

  // Symlinks.
  skillFile(ext, "linked-skill");
  write(ext, "file-skill.md", fm(["name: file-skill", "description: Linked root file."]));
  write(ext, "real-skill.md", fm(["name: sym-skillmd", "description: Linked SKILL.md."]));
  trySymlink(path.join(ext, "linked-skill"), path.join(root, "link-dir"), "dir");
  trySymlink(path.join(ext, "file-skill.md"), path.join(root, "linked-file.md"), "file");
  trySymlink(path.join(ext, "real-skill.md"), path.join(root, "sym-skillmd", "SKILL.md"), "file");
  trySymlink(path.join(ext, "does-not-exist"), path.join(root, "broken-link"), "dir");
  trySymlink(path.join(ext, "does-not-exist.md"), path.join(root, "broken-file.md"), "file");
  trySymlink(
    path.join(ext, "does-not-exist.md"),
    path.join(root, "broken-skillmd", "SKILL.md"),
    "file",
  );
  trySymlink(path.join(ext, "linked-skill"), path.join(root, "skillmd-to-dir", "SKILL.md"), "dir");
  skillFile(root, "cycle/inner");
  trySymlink(path.join(root, "cycle"), path.join(root, "cycle", "again"), "dir");
}

function expectSameAsPi(dir: string, source: string): { skills: Skill[] } {
  const ours = loadSkillsFromDir({ dir, source });
  const theirs = piLoadSkillsFromDir({ dir, source });
  expect(ours).toStrictEqual(theirs);
  expect(JSON.stringify(ours)).toBe(JSON.stringify(theirs));
  expect(formatSkillsForPrompt(ours.skills)).toBe(piFormatSkillsForPrompt(theirs.skills));
  return ours;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-skill-loader-diff-"));
});

afterAll(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("loadSkillsFromDir vs pi-coding-agent", () => {
  let mainRoot = "";

  beforeAll(() => {
    mainRoot = path.join(tmpRoot, "main-tree");
    buildMainTree(mainRoot, path.join(tmpRoot, "external"));
  });

  it("returns the same skills, diagnostics and prompt for a large mixed tree", () => {
    const ours = expectSameAsPi(mainRoot, "bitterbot-workspace");
    const names = ours.skills.map((s) => s.name);
    // Guards against a vacuous comparison: the tree really exercises the rules.
    expect(names).toContain("valid-skill");
    expect(names).toContain("deep-skill");
    expect(names).toContain("root-note");
    expect(names).not.toContain("nested");
    expect(names).not.toContain("pkg");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("x");
    expect(names.filter((n) => n === "shared")).toHaveLength(2);
    const theirs = piLoadSkillsFromDir({ dir: mainRoot, source: "bitterbot-workspace" });
    expect(theirs.skills.length).toBeGreaterThan(30);
    expect(theirs.diagnostics.length).toBeGreaterThan(20);
    const messages = theirs.diagnostics.map((d) => d.message);
    expect(messages).toContain("description.trim is not a function");
    expect(messages).toContain("name.startsWith is not a function");
    expect(messages).toContain("description is required");
  });

  it.each(["user", "project", "path", "bitterbot-bundled", "bitterbot-managed", ""])(
    "builds the same sourceInfo for source %j",
    (source) => {
      const ours = expectSameAsPi(mainRoot, source);
      expect(ours.skills.length).toBeGreaterThan(0);
    },
  );

  it("matches for every subdirectory of the tree used as the scan root", () => {
    const dirs = fs
      .readdirSync(mainRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(mainRoot, entry.name));
    expect(dirs.length).toBeGreaterThan(50);
    for (const dir of dirs) {
      expectSameAsPi(dir, "bitterbot-workspace");
    }
  });

  it("matches when the root itself is a skill", () => {
    const root = path.join(tmpRoot, "root-skill");
    write(root, "SKILL.md", fm(["name: root-skill", "description: The root is a skill."]));
    skillFile(root, "other");
    write(root, "note.md", fm(["name: note", "description: Root note."]));
    const ours = expectSameAsPi(root, "bitterbot-workspace");
    expect(ours.skills).toHaveLength(1);
  });

  it("matches when the root SKILL.md has no description", () => {
    const root = path.join(tmpRoot, "root-skill-bad");
    write(root, "SKILL.md", "# nothing\n");
    skillFile(root, "other");
    const ours = expectSameAsPi(root, "bitterbot-workspace");
    expect(ours.skills).toHaveLength(0);
  });

  it("matches when the root SKILL.md is ignored", () => {
    const root = path.join(tmpRoot, "root-skill-ignored");
    write(root, ".gitignore", "/SKILL.md\n");
    write(root, "SKILL.md", fm(["name: root-skill-ignored", "description: Ignored."]));
    skillFile(root, "child");
    write(root, "note.md", fm(["name: note", "description: Root note."]));
    expectSameAsPi(root, "bitterbot-workspace");
  });

  it("matches with negation and re-inclusion patterns", () => {
    const root = path.join(tmpRoot, "negation");
    write(root, ".gitignore", "*\n!keep/\n!keep/**\n!*.md\nsecret.md\n");
    skillFile(root, "keep/inner");
    skillFile(root, "drop/inner");
    write(root, "top.md", fm(["name: top", "description: Top."]));
    write(root, "secret.md", fm(["name: secret", "description: Secret."]));
    expectSameAsPi(root, "bitterbot-workspace");
  });

  it("matches when an ignore pattern compiles to an invalid regular expression", () => {
    // `a\\[` compiles to an unterminated character class. The matcher throws
    // on every path test once the rule is in, and the scan swallows the error.
    const rootLevel = path.join(tmpRoot, "invalid-regex-root");
    write(rootLevel, ".gitignore", "a\\\\[\n");
    skillFile(rootLevel, "one");
    write(rootLevel, "top.md", fm(["name: top", "description: Top."]));
    const ours = expectSameAsPi(rootLevel, "bitterbot-workspace");
    expect(ours.skills).toHaveLength(0);

    // In a nested ignore file the rule arrives mid-walk: what was found before
    // it stays, everything tested after it is lost.
    const nested = path.join(tmpRoot, "invalid-regex-nested");
    write(nested, "poison/.gitignore", "b[\\\\\n[z-a]x\n\\\\(\n");
    skillFile(nested, "poison/inner");
    for (const name of ["aa", "bb", "cc", "dd", "ee", "ff", "qq", "zz"]) {
      skillFile(nested, name);
    }
    write(nested, "top.md", fm(["name: top", "description: Top."]));
    expectSameAsPi(nested, "bitterbot-workspace");
  });

  it("matches for an unreadable-as-directory, missing or empty root", () => {
    const fileAsDir = path.join(tmpRoot, "plain-file.md");
    fs.writeFileSync(fileAsDir, fm(["name: plain-file", "description: A file."]));
    const empty = path.join(tmpRoot, "empty-root");
    fs.mkdirSync(empty);
    for (const dir of [fileAsDir, empty, path.join(tmpRoot, "does-not-exist"), ""]) {
      const ours = expectSameAsPi(dir, "bitterbot-workspace");
      expect(ours.skills).toHaveLength(0);
    }
  });

  it("matches for a relative root and a root with a trailing separator", () => {
    expectSameAsPi(path.relative(process.cwd(), mainRoot), "bitterbot-workspace");
    expectSameAsPi(`${mainRoot}${path.sep}`, "bitterbot-workspace");
    expectSameAsPi(path.join(mainRoot, "group", "..", "group"), "bitterbot-workspace");
  });

  it("matches on the repo's bundled skills directory", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.resolve(here, "../../../skills");
    if (!fs.existsSync(bundled)) {
      return;
    }
    const ours = expectSameAsPi(bundled, "bitterbot-bundled");
    expect(ours.skills.length).toBeGreaterThan(0);
  });
});

describe("formatSkillsForPrompt vs pi-coding-agent", () => {
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

  const cases: Array<[string, Skill[]]> = [
    ["no skills", []],
    ["one skill", [skill({})]],
    ["only hidden skills", [skill({ disableModelInvocation: true })]],
    [
      "hidden skills among visible ones",
      [
        skill({ name: "a" }),
        skill({ name: "b", disableModelInvocation: true }),
        skill({ name: "c" }),
      ],
    ],
    [
      "characters that need XML escaping",
      [
        skill({
          name: `<n&"'>`,
          description: `a < b && c > d "quoted" 'single' &amp; $& $1 $$`,
          filePath: `/path with spaces/&<>"'/SKILL.md`,
        }),
      ],
    ],
    [
      "multi-line and unicode descriptions",
      [
        skill({ description: "Line one.\nLine two.\r\n\tTabbed.\n" }),
        skill({ name: "uni", description: "Résumé 技能 \u{1F680}" }),
        skill({ name: "", description: "" }),
      ],
    ],
    ["duplicate names", [skill({}), skill({}), skill({ filePath: "/other/demo/SKILL.md" })]],
  ];

  it.each(cases)("formats %s the same", (_label, skills) => {
    expect(formatSkillsForPrompt(skills)).toBe(piFormatSkillsForPrompt(skills));
  });
});

describe("SkillIgnoreMatcher vs the ignore package", () => {
  const piIgnore = loadPiIgnoreFactory();

  type Outcome = { ignored: boolean } | { error: string };

  const outcome = (fn: () => boolean): Outcome => {
    try {
      return { ignored: fn() };
    } catch (error) {
      const e = error as Error;
      return { error: `${e.name}: ${e.message}` };
    }
  };

  const PATHS = [
    "a",
    "a/",
    "b",
    "foo",
    "foo/",
    "foo/bar",
    "foo/bar/",
    "a/b",
    "a/b/",
    "a/foo",
    "a/foo/",
    "foo.md",
    "a/foo.md",
    "bar/foo/a",
    "bar/foo/a/",
    ".md",
    "a.md",
    "SKILL.md",
    "foo/SKILL.md",
    "a b",
    "a b/",
    "a/b/foo/bar",
    "a/b/foo/bar/",
    "!a",
    "#a",
    "a$",
    "a.b",
    "[a]",
    "a-b",
    "(a)",
    "{a}",
    "a+",
    "a|b",
    "a^",
    "a\\b",
    "*",
    "a*",
    "?",
    "FOO",
    "Foo/Bar",
    "z",
    "0",
    "foo/a/b/bar",
    "foobar",
    "barfoo/",
    " a",
    "a ",
    "",
    "/a",
    "./a",
    "../a",
    ".",
    "..",
    ".a",
    "a/..",
  ];

  const seen = { ignored: 0, notIgnored: 0, errors: 0 };

  const compare = (patternSets: string[][]): void => {
    const ours = createSkillIgnoreMatcher();
    const theirs = piIgnore();
    for (const patterns of patternSets) {
      ours.add(patterns);
      theirs.add(patterns);
      for (const p of PATHS) {
        const expected = outcome(() => theirs.ignores(p));
        const actual = outcome(() => ours.ignores(p));
        if ("error" in expected) {
          seen.errors++;
        } else if (expected.ignored) {
          seen.ignored++;
        } else {
          seen.notIgnored++;
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          expect({ patternSets, path: p, outcome: actual }).toStrictEqual({
            patternSets,
            path: p,
            outcome: expected,
          });
        }
      }
    }
  };

  it("agrees on hand-picked patterns", () => {
    const sets: string[][][] = [
      [["foo"]],
      [["foo/"]],
      [["/foo"]],
      [["foo/bar"]],
      [["*.md"]],
      [["*.md", "!a.md"]],
      [["*", "!foo/", "!foo/**"]],
      [["**/foo"]],
      [["foo/**"]],
      [["a/**/bar"]],
      [["**"]],
      [["a*"]],
      [["a?"]],
      [["?"]],
      [["[a-z]"]],
      [["[z-a]"]],
      [["[a"]],
      [["a]"]],
      [["\\[a\\]"]],
      [["\\!a"]],
      [["\\#a"]],
      [["#a"]],
      [["!a"]],
      [["a "]],
      [["a\\ "]],
      [[" a"]],
      [["a\\"]],
      [["a\\\\"]],
      [["  "]],
      [[""]],
      [["a|b"]],
      [["a$"]],
      [["(a)"]],
      [["{a}"]],
      [["a+"]],
      [["a^"]],
      [["a.b"]],
      [["﻿foo"]],
      [["FOO"]],
      [["foo"], ["!foo"]],
      [["foo/"], ["!foo/bar"]],
      [["!foo"], ["foo"], ["!foo/bar"]],
      [["a/b/"], ["a/"], ["!a/b/"]],
      [["group/local-only", "group/rooted-here", "!group/renegated", "group/*.md"]],
    ];
    for (const set of sets) {
      compare(set);
    }
  });

  it("agrees on generated patterns, including the errors thrown", () => {
    const TOKENS = [
      "a",
      "b",
      "foo",
      "bar",
      ".md",
      "/",
      "/",
      "*",
      "*",
      "**",
      "?",
      "!",
      "\\",
      "\\",
      "[",
      "]",
      "-",
      "#",
      " ",
      "$",
      ".",
      "(",
      ")",
      "{",
      "}",
      "+",
      "|",
      "^",
      "z",
      "0",
      "\t",
      "SKILL.md",
      "﻿",
    ];
    // mulberry32: fixed seed, so a failure reproduces.
    let state = 0x5eed1234;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (): string => TOKENS[Math.floor(next() * TOKENS.length)] ?? "a";
    const pattern = (): string => {
      const length = 1 + Math.floor(next() * 7);
      let out = "";
      for (let i = 0; i < length; i++) {
        out += pick();
      }
      return out;
    };
    let invalidRegex = 0;
    for (let i = 0; i < 6000; i++) {
      const sets: string[][] = [];
      const setCount = 1 + Math.floor(next() * 2);
      for (let s = 0; s < setCount; s++) {
        const patterns: string[] = [];
        const count = 1 + Math.floor(next() * 3);
        for (let p = 0; p < count; p++) {
          patterns.push(pattern());
        }
        sets.push(patterns);
      }
      compare(sets);
      const probe = piIgnore().add(sets.flat());
      if ("error" in outcome(() => probe.ignores("a/b/foo/bar"))) {
        invalidRegex++;
      }
    }
    // The comparison is not vacuous: every kind of outcome was seen many times.
    expect(invalidRegex).toBeGreaterThan(20);
    expect(seen.ignored).toBeGreaterThan(5000);
    expect(seen.notIgnored).toBeGreaterThan(5000);
    expect(seen.errors).toBeGreaterThan(5000);
  });
});
