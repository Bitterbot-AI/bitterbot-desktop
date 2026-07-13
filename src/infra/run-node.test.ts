import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");
        // An existing bundle: the entry-bundle branch must NOT fire here, so
        // this test stays focused on the tsdown --no-clean preservation path.
        await fs.writeFile(path.join(tmp, "dist", "entry.js"), "// prebuilt\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === "pnpm") {
            void fs.writeFile(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              void fs.rm(path.join(tmp, "dist", "control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            BITTERBOT_FORCE_BUILD: "1",
            BITTERBOT_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([[process.execPath, "bitterbot.mjs", "--version"]]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "bundles dist/entry.js on a fresh checkout where it is missing",
    async () => {
      await withTempDir(async (tmp) => {
        // Fresh checkout: no dist/entry.js. tsdown alone never creates it, so
        // without the entry-bundle step bitterbot.mjs would crash on boot with
        // "missing dist/entry.(m)js". Assert we bundle it BEFORE launching.
        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
            // Faithfully simulate the real bundler producing the artifact.
            if (args[0] === "scripts/build-gateway-entry.mjs") {
              void fs
                .mkdir(path.join(tmp, "dist"), { recursive: true })
                .then(() =>
                  fs.writeFile(path.join(tmp, "dist", "entry.js"), "// bundled\n", "utf-8"),
                );
            }
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            BITTERBOT_FORCE_BUILD: "1",
            BITTERBOT_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        // Entry bundle is built first, THEN the gateway launches.
        expect(nodeCalls).toEqual([
          [process.execPath, "scripts/build-gateway-entry.mjs"],
          [process.execPath, "bitterbot.mjs", "--version"],
        ]);
      });
    },
  );
});
