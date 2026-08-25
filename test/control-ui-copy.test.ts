import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoEmbeddedToken,
  copyControlUiAssets,
  readGatewayTokenForGuard,
} from "../scripts/control-ui-copy.js";

const dirs: string[] = [];

const makeTmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "bb-control-ui-"));
  dirs.push(d);
  return d;
};

/** Write a fake Vite build: index.html plus content-hashed assets. */
const writeRenderer = async (dir: string, assets: string[], html = "<!doctype html>") => {
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  for (const a of assets) {
    await fs.writeFile(path.join(dir, "assets", a), `/* ${a} */`, "utf8");
  }
};

const lsAssets = async (outDir: string) =>
  (await fs.readdir(path.join(outDir, "assets"), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      await fs.rm(d, { recursive: true, force: true });
    }
  }
});

describe("control-ui-copy", () => {
  const noToken = { BITTERBOT_GATEWAY_TOKEN: "", BITTERBOT_STATE_DIR: "/nonexistent-bb-state" };

  it("stages the renderer output", async () => {
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    await writeRenderer(srcDir, ["app-aaa.js", "app-aaa.css"]);
    const res = await copyControlUiAssets({ srcDir, outDir, env: noToken });
    expect(res?.copied).toBe(3);
    expect(await lsAssets(outDir)).toEqual(["app-aaa.css", "app-aaa.js"]);
    expect(await fs.readFile(path.join(outDir, "index.html"), "utf8")).toContain("<!doctype html>");
  });

  it("keeps the previous generation's assets so open tabs do not 404", async () => {
    // The headline feature is that a UI update needs no restart, which is exactly
    // the case with no reload trigger: a tab holding the old index.html must still
    // be able to fetch its lazy chunks.
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    await writeRenderer(srcDir, ["app-gen1.js"]);
    await copyControlUiAssets({ srcDir, outDir, env: noToken });

    await fs.rm(path.join(srcDir, "assets", "app-gen1.js"));
    await writeRenderer(srcDir, ["app-gen2.js"]);
    await copyControlUiAssets({ srcDir, outDir, env: noToken });

    expect(await lsAssets(outDir)).toEqual(["app-gen1.js", "app-gen2.js"]);
  });

  it("prunes assets older than the previous generation", async () => {
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    for (const gen of ["gen1", "gen2", "gen3"]) {
      await fs.rm(path.join(srcDir, "assets"), { recursive: true, force: true });
      await writeRenderer(srcDir, [`app-${gen}.js`]);
      await copyControlUiAssets({ srcDir, outDir, env: noToken });
    }
    // gen1 is two generations back and must be gone; gen2 and gen3 stay.
    expect(await lsAssets(outDir)).toEqual(["app-gen2.js", "app-gen3.js"]);
  });

  it("never prunes on the first run over a pre-existing directory", async () => {
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    await fs.mkdir(path.join(outDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(outDir, "assets", "legacy-xyz.js"), "old", "utf8");
    await writeRenderer(srcDir, ["app-new.js"]);
    await copyControlUiAssets({ srcDir, outDir, env: noToken });
    expect(await lsAssets(outDir)).toEqual(["app-new.js", "legacy-xyz.js"]);
  });

  it("throws when the renderer has not been built", async () => {
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    await expect(copyControlUiAssets({ srcDir, outDir, env: noToken })).rejects.toThrow(
      /Missing Control UI build output/,
    );
  });

  it("skips instead of throwing when the escape hatch is set", async () => {
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    const res = await copyControlUiAssets({
      srcDir,
      outDir,
      env: { ...noToken, BITTERBOT_CONTROL_UI_SKIP_MISSING: "1" },
    });
    expect(res).toBeNull();
  });

  it("refuses to stage a bundle that embeds the gateway token", async () => {
    // Guards the exact hazard that reorders this plan: desktop/vite.config.ts bakes
    // the token in via `define`, and anything staged here gets served over HTTP.
    const srcDir = await makeTmp();
    const outDir = await makeTmp();
    const token = "a".repeat(48);
    await writeRenderer(srcDir, ["app-tok.js"]);
    await fs.writeFile(
      path.join(srcDir, "assets", "app-tok.js"),
      `const t="${token}";export default t;`,
      "utf8",
    );
    await expect(
      copyControlUiAssets({ srcDir, outDir, env: { BITTERBOT_GATEWAY_TOKEN: token } }),
    ).rejects.toThrow(/embeds the gateway auth token/);
    // and nothing was staged
    expect(await lsAssets(outDir)).toEqual([]);
  });

  it("token guard is a no-op when no token is available", async () => {
    await expect(
      assertNoEmbeddedToken({ srcDir: "/tmp", files: ["a.js"], token: null }),
    ).resolves.toBeUndefined();
  });

  it("reads the token from the environment ahead of the config file", async () => {
    expect(await readGatewayTokenForGuard({ BITTERBOT_GATEWAY_TOKEN: "x".repeat(20) })).toBe(
      "x".repeat(20),
    );
  });

  it("returns null when there is no token to guard against", async () => {
    expect(
      await readGatewayTokenForGuard({
        BITTERBOT_GATEWAY_TOKEN: "",
        BITTERBOT_STATE_DIR: "/nonexistent-bb-state",
      }),
    ).toBeNull();
  });
});
