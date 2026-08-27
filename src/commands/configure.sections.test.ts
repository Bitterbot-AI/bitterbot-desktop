import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIGURE_SECTION_OPTIONS, CONFIGURE_WIZARD_SECTIONS } from "./configure.shared.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

// Gitignored/local-only or generated docs trees — not user-facing surface.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
const EXCLUDED_DOC_SUBDIRS = ["docs/plans", "docs/reviews", "docs/zh-CN", "docs/.i18n"];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, full);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (EXCLUDED_DOC_SUBDIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|md|mdx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

describe("configure --section advertising (PLAN-41 p0-12)", () => {
  it("every `configure --section <name>` string in src/docs points at a real section", () => {
    const files: string[] = [];
    for (const dir of ["src", "docs"]) {
      walk(path.join(REPO_ROOT, dir), files);
    }
    for (const extra of ["README.md", ".env.example"]) {
      const full = path.join(REPO_ROOT, extra);
      if (fs.existsSync(full)) files.push(full);
    }

    const valid = new Set<string>(CONFIGURE_WIZARD_SECTIONS);
    const offenders: string[] = [];
    const re = /configure --section[ =]([a-z][a-z-]*)/g;
    for (const file of files) {
      const body = fs.readFileSync(file, "utf8");
      for (const match of body.matchAll(re)) {
        const name = match[1]!;
        if (!valid.has(name)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: --section ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the interactive menu offers exactly the section list", () => {
    expect(CONFIGURE_SECTION_OPTIONS.map((o) => o.value)).toEqual([...CONFIGURE_WIZARD_SECTIONS]);
  });
});
