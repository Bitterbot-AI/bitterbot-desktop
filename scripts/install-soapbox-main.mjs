/** Local pilot deployment. Prepare is read-only to the live configuration; activate keeps a rollback copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

assert.equal(process.platform, "linux", "Run under the main app's Linux/WSL user");
const root = path.resolve(import.meta.dirname, "..");
const state = path.join(homedir(), ".bitterbot");
const target = path.join(state, "compute");
const configPath = path.join(state, "bitterbot.json");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const output = path.join(root, "dist/soapbox-integration");
const action = process.argv[2] ?? "prepare";
await mkdir(target, { recursive: true, mode: 0o700 });
const preparedPath = path.join(target, "prepared.json");
const markerPath = path.join(target, "prepared-state.json");
if (action === "prepare") {
  const build = await readJson(path.join(output, "build.json"));
  const installed = await readJson(path.join(state, "app/current/package.json"));
  assert.equal(build.version, installed.version, "UI must match the installed release");
  const original = await readFile(configPath, "utf8");
  const config = JSON.parse(original);
  const deployment = path.join(target, `release-${build.version}-${Date.now()}`);
  await cp(path.join(output, "ui"), path.join(deployment, "ui"), { recursive: true });
  await cp(path.join(output, "plugin"), path.join(deployment, "plugin"), { recursive: true });
  config.plugins ??= {};
  config.plugins.load ??= {};
  const otherPluginPaths = (config.plugins.load.paths ?? []).filter(
    (entry) =>
      !(entry.startsWith(path.join(target, "release-")) && path.basename(entry) === "plugin"),
  );
  config.plugins.load.paths = [...new Set([...otherPluginPaths, path.join(deployment, "plugin")])];
  config.plugins.entries ??= {};
  config.plugins.entries["soapbox-compute"] = {
    enabled: true,
    config: { repository: root, stateDirectory: path.join(homedir(), ".bitterbot-soapbox-pilot") },
  };
  if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes("soapbox-compute"))
    config.plugins.allow.push("soapbox-compute");
  config.gateway ??= {};
  config.gateway.controlUi = {
    ...config.gateway.controlUi,
    enabled: true,
    root: path.join(deployment, "ui"),
  };
  assert.deepEqual(config.tools?.wallet, JSON.parse(original).tools?.wallet);
  await writeFile(preparedPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(markerPath, JSON.stringify({ original_sha256: digest(original), deployment }), {
    mode: 0o600,
  });
  console.log(`Prepared compatible UI and plugin at ${deployment}; live app unchanged.`);
} else if (action === "activate") {
  const marker = await readJson(markerPath);
  const original = await readFile(configPath, "utf8");
  assert.equal(
    digest(original),
    marker.original_sha256,
    "Main config changed; prepare again before activating",
  );
  const config = await readJson(preparedPath);
  assert.deepEqual(config.tools?.wallet, JSON.parse(original).tools?.wallet);
  const pilot = path.join(homedir(), ".bitterbot-soapbox-pilot");
  const pid = Number(await readFile(path.join(pilot, "launcher.pid"), "utf8"));
  if (Number.isSafeInteger(pid) && pid > 1) {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    // A main-app service belongs to the plugin lifecycle; stopping it here races its supervisor.
    if (
      cmdline.includes(path.join(root, "scripts/soapbox-desktop-pilot.ts")) &&
      !cmdline.includes("\0--services-only\0")
    ) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(
        await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
        "",
        "Old pilot must stop first",
      );
    }
  }
  // Keep the existing test identity and spending reservations. Never copy main wallet state.
  const wallet = path.join(homedir(), ".bitterbot-soapbox/wallet/base-sepolia");
  await mkdir(wallet, { recursive: true, mode: 0o700 });
  for (const file of ["wallet-data.json", "tx-history.json"]) {
    const old = path.join(pilot, "wallet", file);
    const destination = path.join(wallet, file);
    try {
      await cp(old, destination, { errorOnExist: true, force: false });
    } catch (error) {
      if (!["EEXIST", "ERR_FS_CP_EEXIST", "ENOENT"].includes(error.code)) throw error;
    }
  }
  const backup = path.join(marker.deployment, "before-config.json");
  await writeFile(backup, original, { mode: 0o600 });
  const mainIdentity = await readFile(path.join(state, "wallet/wallet-data.json"), "utf8");
  await writeFile(path.join(marker.deployment, "main-wallet-before.sha256"), digest(mainIdentity), {
    mode: 0o600,
  });
  await writeFile(`${configPath}.soapbox-next`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(`${configPath}.soapbox-next`, configPath);
  await writeFile(
    path.join(target, "active.json"),
    JSON.stringify(
      {
        url: "http://127.0.0.1:19001/",
        deployment: marker.deployment,
        activated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Activated Compute. Original configuration retained at ${backup}`);
  console.log(
    "The gateway config watcher will restart the app with the plugin. Main wallet configuration is unchanged.",
  );
} else {
  throw new Error("Usage: install-soapbox-main.mjs prepare|activate");
}
