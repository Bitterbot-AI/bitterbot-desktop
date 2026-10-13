import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  carriedServiceEnv,
  copyDotEnvKeys,
  insertEnvironmentFiles,
  parseEnvironmentFiles,
  planDotEnvMerge,
  processOnlyEnvNames,
  readProcEnviron,
  serializeDotEnvValue,
} from "./gateway-switch-env.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-switch-env-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("copying a git clone's .env keys into the state directory", () => {
  const clone = [
    "# clone secrets",
    "OPENAI_API_KEY=sk-openai",
    "CDP_API_KEY_SECRET='-----BEGIN EC PRIVATE KEY-----\\nabc\\n-----END EC PRIVATE KEY-----'",
    'MULTI="line one\\nline two"',
    "RPC_URL=https://mainnet.base.org",
    "ANTHROPIC_API_KEY=from-clone",
    "",
  ].join("\n");

  it("plans only the missing keys and never an existing one", () => {
    const plan = planDotEnvMerge(clone, "ANTHROPIC_API_KEY=already-here\n");
    expect(plan.keys).toEqual(["OPENAI_API_KEY", "CDP_API_KEY_SECRET", "MULTI", "RPC_URL"]);
    expect(plan.lines.join("\n")).not.toContain("from-clone");
  });

  it("copies (never moves), backs up the target, keeps its content and mode 0600, values round-trip", () => {
    const source = path.join(dir, "clone", ".env");
    const target = path.join(dir, "state", ".env");
    fs.mkdirSync(path.dirname(source));
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(source, clone);
    fs.writeFileSync(target, "# mine\nANTHROPIC_API_KEY=already-here", { mode: 0o600 });
    const now = new Date("2026-10-13T12:00:00Z");
    const res = copyDotEnvKeys({ source, target, now });
    expect(res.copied).toEqual(["OPENAI_API_KEY", "CDP_API_KEY_SECRET", "MULTI", "RPC_URL"]);
    // The clone's file is untouched.
    expect(fs.readFileSync(source, "utf8")).toBe(clone);
    // Backup of the previous target.
    expect(res.backup).toBe(`${target}.bak-20261013T120000Z`);
    expect(fs.readFileSync(res.backup!, "utf8")).toBe("# mine\nANTHROPIC_API_KEY=already-here");
    const text = fs.readFileSync(target, "utf8");
    expect(text.startsWith("# mine\nANTHROPIC_API_KEY=already-here\n")).toBe(true);
    expect(text).toContain(`# Copied from ${source}`);
    const parsed = dotenv.parse(text);
    const original = dotenv.parse(clone);
    expect(parsed.ANTHROPIC_API_KEY).toBe("already-here");
    for (const key of res.copied) {
      expect(parsed[key]).toBe(original[key]);
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(res.backup!).mode & 0o777).toBe(0o600);
    }
    // Running it again copies nothing and makes no new backup.
    expect(copyDotEnvKeys({ source, target, now })).toEqual({
      copied: [],
      skipped: [],
      backup: null,
    });
  });

  it("creates the target when there is none, and skips values it cannot write safely", () => {
    const source = path.join(dir, ".env.clone");
    const target = path.join(dir, "state", ".env");
    fs.writeFileSync(source, `A=1\nWEIRD="it's \\"quoted\\" and\nmultiline"\n`);
    const res = copyDotEnvKeys({ source, target });
    expect(res.backup).toBeNull();
    expect(dotenv.parse(fs.readFileSync(target, "utf8")).A).toBe("1");
    expect(serializeDotEnvValue(`it's "x"\nmore`)).toBeNull();
  });
});

describe("carrying the old environment", () => {
  it("keeps keys and state selection, drops install and service-manager markers", () => {
    expect(
      carriedServiceEnv({
        BITTERBOT_STATE_DIR: "/srv/bb",
        BITTERBOT_PROFILE: "work",
        OPENAI_API_KEY: "x",
        PATH: "/usr/bin",
        BITTERBOT_INSTALL_ROOT: "/old",
        BITTERBOT_SERVICE_VERSION: "1.4.0",
        npm_package_version: "1.4.0",
      }),
    ).toEqual({ BITTERBOT_STATE_DIR: "/srv/bb", BITTERBOT_PROFILE: "work", OPENAI_API_KEY: "x" });
  });

  it("names provider keys the old process had from neither .env (never values)", () => {
    expect(
      processOnlyEnvNames({
        processEnv: {
          GITHUB_TOKEN: "ghp",
          OPENAI_API_KEY: "sk",
          BITTERBOT_STATE_DIR: "/x",
          BITTERBOT_NODE_OPTIONS_READY: "1",
          LANG: "C",
        },
        known: [{ OPENAI_API_KEY: "sk" }, {}],
      }),
    ).toEqual(["BITTERBOT_STATE_DIR", "GITHUB_TOKEN"]);
  });

  it("reads a process environment from /proc", () => {
    fs.mkdirSync(path.join(dir, "77"));
    fs.writeFileSync(path.join(dir, "77", "environ"), "A=1\0B=x=y\0");
    expect(readProcEnviron(77, dir)).toEqual({ A: "1", B: "x=y" });
    expect(readProcEnviron(78, dir)).toBeNull();
  });
});

describe("systemd EnvironmentFile= lines", () => {
  it("are read from the old unit and added to the new one once", () => {
    const old =
      "[Unit]\nDescription=x\n\n[Service]\nEnvironmentFile=/home/u/secrets.env\nExecStart=a\n";
    const files = parseEnvironmentFiles(old);
    expect(files).toEqual(["/home/u/secrets.env"]);
    const fresh = "[Unit]\nDescription=y\n\n[Service]\nExecStart=b\nRestart=always\n";
    const next = insertEnvironmentFiles(fresh, files);
    expect(next).toContain("[Service]\nEnvironmentFile=/home/u/secrets.env\nExecStart=b");
    expect(insertEnvironmentFiles(next, files)).toBe(next);
  });
});
