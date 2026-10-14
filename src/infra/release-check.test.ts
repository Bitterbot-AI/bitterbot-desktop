/**
 * scripts/release-check.ts: the lifecycle-hook and manifest assertions that
 * stop a package `npm install` can not install from reaching the registry.
 */
import { describe, expect, it } from "vitest";
import {
  binProblems,
  lifecycleFileRefs,
  lifecycleProblems,
  relativeImports,
  REQUIRED_PATHS,
  unresolvableSpecProblems,
} from "../../scripts/release-check.ts";

const HOOKS = {
  preinstall: "node scripts/preinstall-check.mjs",
  postinstall: "node scripts/fetch-orchestrator.mjs",
  prepack: "pnpm build",
};

const SOURCES: Record<string, string> = {
  "scripts/preinstall-check.mjs": 'import fs from "node:fs";\n',
  "scripts/fetch-orchestrator.mjs":
    'import { x } from "node:os";\nconst m = await import("./orchestrator-signature.mjs");\n',
  "scripts/orchestrator-signature.mjs": 'export { a } from "./lib/util.mjs";\n',
  "scripts/lib/util.mjs": "export const a = 1;\n",
};

const readFile = (rel: string) => SOURCES[rel] ?? null;

describe("lifecycleFileRefs", () => {
  it("finds the files a hook runs", () => {
    expect(lifecycleFileRefs("node scripts/a.mjs && node ./b/c.js --flag")).toEqual([
      "scripts/a.mjs",
      "b/c.js",
    ]);
    expect(lifecycleFileRefs('sh "scripts/x.sh"; echo done')).toEqual(["scripts/x.sh"]);
    expect(lifecycleFileRefs("pnpm build")).toEqual([]);
  });
});

describe("relativeImports", () => {
  it("collects static, side-effect, re-export and literal dynamic imports", () => {
    const src = [
      'import a from "./a.mjs";',
      'import "../b.mjs";',
      'export { c } from "./c.mjs";',
      'const d = await import("./d.mjs");',
      'import e from "node:fs";',
      "const f = await import(name);",
    ].join("\n");
    expect(relativeImports(src).toSorted()).toEqual(["../b.mjs", "./a.mjs", "./c.mjs", "./d.mjs"]);
  });
});

describe("lifecycleProblems", () => {
  it("passes when every hook file and its imports ship", () => {
    const packPaths = new Set(Object.keys(SOURCES));
    expect(lifecycleProblems({ scripts: HOOKS, packPaths, readFile })).toEqual([]);
  });

  it("fails the 1.5.0 shape: hooks that run files outside `files`", () => {
    const problems = lifecycleProblems({ scripts: HOOKS, packPaths: new Set(), readFile });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("preinstall");
    expect(problems[0]).toContain("scripts/preinstall-check.mjs");
    expect(problems[1]).toContain("scripts/fetch-orchestrator.mjs");
  });

  it("follows imports transitively", () => {
    const packPaths = new Set([
      "scripts/preinstall-check.mjs",
      "scripts/fetch-orchestrator.mjs",
      "scripts/orchestrator-signature.mjs",
    ]);
    const problems = lifecycleProblems({ scripts: HOOKS, packPaths, readFile });
    expect(problems).toEqual([
      "scripts/orchestrator-signature.mjs (run by postinstall) needs scripts/lib/util.mjs, which is not in the package",
    ]);
  });

  it("refuses hooks that need tools a package install lacks; ignores prepack", () => {
    const problems = lifecycleProblems({
      scripts: {
        postinstall: "pnpm run setup",
        install: "node --import tsx x.ts",
        prepack: "pnpm build",
      },
      packPaths: new Set(["x.ts"]),
      readFile: () => "",
    });
    expect(problems.join("\n")).toMatch(/install "node --import tsx x.ts" needs tsx/);
    expect(problems.join("\n")).toMatch(/postinstall "pnpm run setup" needs pnpm/);
    expect(problems.join("\n")).not.toMatch(/prepack/);
  });
});

describe("manifest checks", () => {
  it("flags registry-unresolvable specs in runtime dependency maps only", () => {
    expect(
      unresolvableSpecProblems({
        dependencies: { a: "workspace:*", b: "^1.0.0" },
        optionalDependencies: { c: "file:../c" },
        devDependencies: { bitterbot: "workspace:*" },
      }),
    ).toEqual([
      'dependencies.a is "workspace:*", which npm cannot install from the registry',
      'optionalDependencies.c is "file:../c", which npm cannot install from the registry',
    ]);
  });

  it("requires the bin target, the Control UI and the orchestrator manifest", () => {
    expect(
      binProblems({ bin: { bitterbot: "bitterbot.mjs" } }, new Set(["bitterbot.mjs"])),
    ).toEqual([]);
    expect(binProblems({ bin: "./cli.js" }, new Set())).toEqual([
      "bin target cli.js is not in the package",
    ]);
    expect(REQUIRED_PATHS).toEqual(
      expect.arrayContaining(["dist/control-ui/index.html", "orchestrator/Cargo.toml"]),
    );
  });
});
