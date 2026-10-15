/**
 * zsh completion must not print "command not found: compdef" when the
 * cached script is sourced before compinit (plain zsh, conda), and caches
 * written before that fix must be regenerated.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completionCacheExists,
  generateZshCompletion,
  isCompletionCacheOutdated,
  resolveCompletionCachePath,
  ZSH_COMPDEF_GUARD_MARKER,
} from "./completion-cli.js";

function program(): Command {
  const p = new Command("bitterbot");
  p.option("--no-color", "disable colour");
  p.command("gateway").description("run the gateway").option("--port <port>", "port");
  p.command("update").description("update");
  return p;
}

const hasZsh = spawnSync("zsh", ["--version"]).status === 0;

describe("zsh completion", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-completion-"));
    prevStateDir = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) {
      delete process.env.BITTERBOT_STATE_DIR;
    } else {
      process.env.BITTERBOT_STATE_DIR = prevStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("guards compdef and loads compinit when it is missing", () => {
    const script = generateZshCompletion(program());
    expect(script).toContain(ZSH_COMPDEF_GUARD_MARKER);
    expect(script).toContain("if ! (( $+functions[compdef] )); then");
    expect(script).toContain("autoload -Uz compinit && compinit -i");
    // No bare compdef line: every compdef call sits inside the guard.
    const bare = script.split("\n").filter((line) => /^compdef\s/.test(line));
    expect(bare).toEqual([]);
    expect(script).toMatch(
      /if \(\( \$\+functions\[compdef\] \)\); then\n {2}compdef _bitterbot_root_completion bitterbot\nfi/,
    );
    expect(isCompletionCacheOutdated("zsh", script)).toBe(false);
  });

  it("treats a cached zsh script from before the guard as missing, so it is regenerated", async () => {
    const cachePath = resolveCompletionCachePath("zsh", "bitterbot");
    expect(cachePath.startsWith(stateDir)).toBe(true);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      "#compdef bitterbot\n\ncompdef _bitterbot_root_completion bitterbot\n",
    );
    expect(await completionCacheExists("zsh", "bitterbot")).toBe(false);
    fs.writeFileSync(cachePath, generateZshCompletion(program()));
    expect(await completionCacheExists("zsh", "bitterbot")).toBe(true);
    // Other shells are unaffected.
    expect(isCompletionCacheOutdated("bash", "complete -F _bitterbot bitterbot")).toBe(false);
  });

  it.skipIf(!hasZsh)("sources cleanly in a zsh without compinit", () => {
    const file = path.join(stateDir, "bitterbot.zsh");
    fs.writeFileSync(file, generateZshCompletion(program()));
    const res = spawnSync("zsh", ["-f", "-c", `source ${JSON.stringify(file)}`], {
      encoding: "utf8",
      env: { ...process.env, ZDOTDIR: stateDir, HOME: stateDir },
      timeout: 30_000,
    });
    expect(res.stderr).not.toContain("command not found");
    expect(res.status).toBe(0);
  });
});
