/**
 * PLAN-56 Phase 2: the image entrypoint's decisions (scripts/docker-entrypoint-lib.sh),
 * run against fixtures without root or Docker. The CI Docker smoke covers the
 * real privilege drop.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = path.resolve(import.meta.dirname, "../../scripts/docker-entrypoint-lib.sh");
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-entrypoint-"));
  tmpDirs.push(dir);
  return dir;
}

function sh(script: string, env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  try {
    const out = execFileSync("sh", ["-c", `. "${LIB}"; ${script}`], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, out: e.stdout ?? "" };
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("docker entrypoint helpers", () => {
  it("recognises only the identity uid map as real root", () => {
    const dir = tmp();
    const write = (name: string, body: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return file;
    };
    const identity = write("identity", "         0          0 4294967295\n");
    const rootless = write(
      "rootless",
      "         0       1000          1\n         1     100000      65536\n",
    );
    const podman = write("podman", "         0       1000          1\n");
    expect(sh(`bb_uid_map_is_identity "${identity}"`).code).toBe(0);
    expect(sh(`bb_uid_map_is_identity "${rootless}"`).code).not.toBe(0);
    expect(sh(`bb_uid_map_is_identity "${podman}"`).code).not.toBe(0);
    // No user-namespace support: no map file at all counts as identity.
    expect(sh(`bb_uid_map_is_identity "${path.join(dir, "missing")}"`).code).toBe(0);
  });

  it("lists only mount points strictly below the directory", () => {
    const dir = tmp();
    const mountinfo = path.join(dir, "mountinfo");
    fs.writeFileSync(
      mountinfo,
      [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 8:1 /data /home/node/.bitterbot rw - ext4 /dev/sda1 rw",
        "3 2 8:1 /ws /home/node/.bitterbot/workspace rw - ext4 /dev/sda1 rw",
        "4 2 8:1 /x /home/node/.bitterbot/extra rw - ext4 /dev/sda1 rw",
        "5 1 8:1 /y /home/node/.bitterbotX rw - ext4 /dev/sda1 rw",
      ].join("\n"),
    );
    const out = sh(`bb_mounts_below /home/node/.bitterbot "${mountinfo}"`).out.trim().split("\n");
    expect(out).toEqual(["/home/node/.bitterbot/workspace", "/home/node/.bitterbot/extra"]);
  });

  it("hands matching entries over, but never descends into another mount below", () => {
    const root = tmp();
    const data = path.join(root, "data");
    fs.mkdirSync(path.join(data, "memory"), { recursive: true });
    fs.mkdirSync(path.join(data, "workspace", "skills"), { recursive: true });
    fs.writeFileSync(path.join(data, "memory", "main.sqlite"), "");
    fs.writeFileSync(path.join(data, "workspace", "skills", "a.md"), "");
    const mountinfo = path.join(root, "mountinfo");
    fs.writeFileSync(
      mountinfo,
      `3 2 8:1 /ws ${path.join(data, "workspace")} rw - ext4 /dev/sda1 rw\n`,
    );
    // A stub chown records what would be re-owned (we are not root).
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const log = path.join(root, "chown.log");
    fs.writeFileSync(
      path.join(bin, "chown"),
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done >> "${log}"\n`,
      {
        mode: 0o755,
      },
    );
    const uid = process.getuid?.() ?? 0;
    const res = sh(`bb_heal_root_owned "${data}" node:node "${mountinfo}" ${uid}`, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(res.code).toBe(0);
    const touched = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
    expect(touched).toContain("-h");
    expect(touched).toContain(path.join(data, "memory", "main.sqlite"));
    expect(touched.some((p) => p.startsWith(path.join(data, "workspace")))).toBe(false);
  });

  it("matches no entry owned by another uid, and a chown failure only warns", () => {
    const root = tmp();
    const data = path.join(root, "data");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "mine"), "");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "chown"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const uid = process.getuid?.() ?? 0;
    // Our files, default uid 0 match: nothing to do, exit 0.
    expect(sh(`bb_heal_root_owned "${data}" node:node /dev/null`, env).code).toBe(0);
    // Forced match with a failing chown: still exit 0 (no crash loop).
    expect(sh(`bb_heal_root_owned "${data}" node:node /dev/null ${uid}`, env).code).toBe(0);
  });
});
