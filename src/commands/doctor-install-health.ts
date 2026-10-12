/**
 * Doctor "Install" section (PLAN-56 Phase 4): the facts a fresh install needs
 * checked once, in one place, for `bitterbot doctor` and the setup page's
 * closing summary.
 *
 * - install kind and update channel;
 * - version drift (the code on disk vs the code running; a config written by
 *   a newer Bitterbot than the one running);
 * - the P2P orchestrator: present, and whether its signature was verified
 *   (re-checked offline: the release-tarball manifest for a tarball install,
 *   the verification record `scripts/fetch-orchestrator.mjs` writes next to a
 *   downloaded binary, the image build for a container);
 * - Playwright and a browser for the browser tool;
 * - the local embedding model (GGUF) when memory uses it.
 *
 * Read-only and offline: no network, no gateway calls, nothing repaired.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import type { InstallKind } from "../infra/install-kind.js";
import { orchestratorMissingAdvice } from "../infra/orchestrator-advice.js";
import {
  type OrchestratorBinaryProbe,
  probeOrchestratorBinary,
} from "../infra/orchestrator-binary.js";
import { readTarballManifest, resolveTarballLayout } from "../infra/tarball-install.js";
import {
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../infra/update-channels.js";
import { compareSemverStrings } from "../infra/update-check.js";
import { type CheckResult, info, ok, renderSection, warn, error } from "./doctor-check.js";

export const INSTALL_HEALTH_SECTION = "Install";

/** File name of the bundled local embedding model (src/memory/embeddings.ts DEFAULT_LOCAL_MODEL). */
export const LOCAL_GGUF_FILE = "embeddinggemma-300m-qat-Q8_0.gguf";

const REMOTE_EMBEDDING_PROVIDERS = new Set(["openai", "gemini", "voyage", "mistral"]);

export type InstallHealthInput = {
  cfg: BitterbotConfig;
  installKind: InstallKind;
  packageRoot: string | null;
  runningVersion: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  /** Test seams. */
  probeOrchestrator?: (cfg: BitterbotConfig["p2p"]) => OrchestratorBinaryProbe;
  resolvePlaywright?: (packageRoot: string | null) => string | null;
  findBrowser?: (cfg: BitterbotConfig) => { kind: string; path: string } | null;
};

function readPackageVersion(root: string | null): string | null {
  if (!root) {
    return null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.promises.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

export function checkInstallKindAndChannel(input: InstallHealthInput): CheckResult {
  const resolved = resolveEffectiveUpdateChannel({
    configChannel: normalizeUpdateChannel(input.cfg.update?.channel),
    installKind: input.installKind,
  });
  return info(
    `Install kind: ${input.installKind}; update channel: ${formatUpdateChannelLabel(resolved)}.`,
  );
}

export function checkVersionDrift(input: InstallHealthInput): CheckResult {
  const running = input.runningVersion;
  const onDisk = readPackageVersion(input.packageRoot);
  if (onDisk && running && onDisk !== running && input.installKind !== "container") {
    const fix =
      input.installKind === "git"
        ? "run `pnpm install && pnpm build`, then restart the gateway"
        : "restart the gateway (and `bitterbot update` if it keeps happening)";
    return warn(
      `Version drift: the files on disk are ${onDisk} but the running code is ${running}. Fix: ${fix}.`,
    );
  }
  const touched = input.cfg.meta?.lastTouchedVersion;
  const cmp = touched ? compareSemverStrings(touched, running) : null;
  if (touched && cmp !== null && cmp > 0) {
    return warn(
      `Version drift: the config was last written by Bitterbot ${touched}, newer than the running ${running}. ` +
        "Settings that version added may be ignored; update this install to match.",
    );
  }
  return ok(`No version drift: running ${running}.`);
}

type VerificationStamp = { version?: string; sha256?: string; signature?: string };

function readStamp(binaryPath: string): VerificationStamp | null {
  try {
    return JSON.parse(fs.readFileSync(`${binaryPath}.verified.json`, "utf8")) as VerificationStamp;
  } catch {
    return null;
  }
}

export async function checkOrchestrator(input: InstallHealthInput): Promise<CheckResult[]> {
  if (input.cfg.p2p?.enabled === false) {
    return [info("P2P orchestrator: not needed (P2P is off).")];
  }
  const probe = (input.probeOrchestrator ?? ((p2p) => probeOrchestratorBinary(p2p, input.env)))(
    input.cfg.p2p,
  );
  if (!probe.found) {
    return [
      warn(
        [
          "P2P orchestrator: NOT FOUND, so the node cannot join the network (everything else works).",
          ...orchestratorMissingAdvice(input.installKind),
        ].join("\n"),
      ),
    ];
  }
  const present = `P2P orchestrator: present at ${probe.path}`;
  switch (probe.source) {
    case "bundled": {
      const layout = resolveTarballLayout(input.packageRoot);
      const manifest = layout ? readTarballManifest(layout.versionDir) : null;
      const rel = layout
        ? path.relative(layout.versionDir, probe.path).split(path.sep).join("/")
        : "";
      const entry = manifest?.files.find((f) => f.path === rel);
      if (!entry || !("sha256" in entry)) {
        return [
          warn(
            `${present}; not listed in the release manifest, so its signature cannot be confirmed.`,
          ),
        ];
      }
      const actual = await sha256File(probe.path).catch(() => null);
      return actual === entry.sha256
        ? [ok(`${present}; signature verified (matches the minisign-signed release manifest).`)]
        : [
            error(
              `${present}; it does NOT match the signed release manifest. Fix: \`bitterbot update --reinstall\`.`,
            ),
          ];
    }
    case "prebuilt": {
      const stamp = readStamp(probe.path);
      if (!stamp?.sha256) {
        return [
          warn(
            `${present}; no verification record (downloaded by an earlier version). Fix: re-run \`node scripts/fetch-orchestrator.mjs\` (or \`pnpm install\`) to re-download and verify it.`,
          ),
        ];
      }
      const actual = await sha256File(probe.path).catch(() => null);
      if (actual !== stamp.sha256) {
        return [
          error(
            `${present}; the file changed after it was verified. Fix: delete it and re-run \`node scripts/fetch-orchestrator.mjs\`.`,
          ),
        ];
      }
      return stamp.signature === "minisign"
        ? [
            ok(
              `${present}; signature verified (minisign, v${stamp.version ?? "?"}), file unchanged.`,
            ),
          ]
        : [warn(`${present}; checked by SHA-256 only (no signature was available at download).`)];
    }
    case "release":
      return input.installKind === "container"
        ? [ok(`${present}; signature verified when the image was built (minisign).`)]
        : [ok(`${present}; built from source, so no signature applies.`)];
    case "debug":
      return [ok(`${present}; debug build from source, so no signature applies.`)];
    default:
      return [
        info(`${present}; operator-supplied (p2p.orchestratorBinary), not verified by Bitterbot.`),
      ];
  }
}

function defaultResolvePlaywright(packageRoot: string | null): string | null {
  try {
    const req = createRequire(
      packageRoot ? path.join(packageRoot, "package.json") : import.meta.url,
    );
    return path.dirname(req.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

async function defaultFindBrowser(cfg: BitterbotConfig) {
  const { resolveBrowserConfig } = await import("../browser/config.js");
  const { resolveBrowserExecutableForPlatform } = await import("../browser/chrome.executables.js");
  try {
    return resolveBrowserExecutableForPlatform(
      resolveBrowserConfig(cfg.browser, cfg),
      process.platform,
    );
  } catch {
    return null;
  }
}

export async function checkPlaywright(input: InstallHealthInput): Promise<CheckResult> {
  if (input.cfg.browser?.enabled === false) {
    return info("Browser tool: off (browser.enabled = false).");
  }
  const pw = (input.resolvePlaywright ?? defaultResolvePlaywright)(input.packageRoot);
  if (!pw) {
    return warn(
      "Browser tool: Playwright (playwright-core) is not installed, so the agent cannot drive a browser. Fix: reinstall Bitterbot.",
    );
  }
  const browser = input.findBrowser
    ? input.findBrowser(input.cfg)
    : await defaultFindBrowser(input.cfg);
  if (!browser) {
    return warn(
      "Browser tool: Playwright is installed but no Chrome, Chromium, Brave or Edge was found. Fix: install one, or `npx playwright install chromium` (the installer's --with-browser does this).",
    );
  }
  return ok(`Browser tool: Playwright present; ${browser.kind} at ${browser.path}.`);
}

export function findLocalGguf(input: InstallHealthInput): { path: string; size: number } | null {
  const local = input.cfg.agents?.defaults?.memorySearch?.local;
  const modelPath = local?.modelPath?.trim();
  const home = input.homedir ?? os.homedir();
  if (modelPath && !/^(hf:|https?:)/i.test(modelPath)) {
    const resolved = modelPath.startsWith("~") ? path.join(home, modelPath.slice(1)) : modelPath;
    try {
      const stat = fs.statSync(resolved);
      return stat.isFile() ? { path: resolved, size: stat.size } : null;
    } catch {
      return null;
    }
  }
  const dir = local?.modelCacheDir?.trim() || path.join(home, ".node-llama-cpp", "models");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wanted = (modelPath ? path.basename(modelPath) : LOCAL_GGUF_FILE).toLowerCase();
  for (const name of names) {
    if (name.toLowerCase().endsWith(wanted)) {
      try {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size > 0) {
          return { path: file, size: stat.size };
        }
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export function checkLocalGguf(input: InstallHealthInput): CheckResult {
  const memorySearch = input.cfg.agents?.defaults?.memorySearch;
  if (memorySearch?.provider && REMOTE_EMBEDDING_PROVIDERS.has(memorySearch.provider)) {
    return info(`Local embedding model: not needed (memory uses ${memorySearch.provider}).`);
  }
  const found = findLocalGguf(input);
  if (found) {
    return ok(
      `Local embedding model (GGUF): present, ${Math.round(found.size / (1024 * 1024))} MB at ${found.path}.`,
    );
  }
  if (memorySearch?.local?.autoDownload === false) {
    return warn(
      "Local embedding model (GGUF): not downloaded and auto-download is off, so memory search is keyword-only until a remote embeddings key is set.",
    );
  }
  return info(
    "Local embedding model (GGUF): not downloaded yet; about 330 MB downloads the first time memory needs it.",
  );
}

export async function collectInstallHealth(input: InstallHealthInput): Promise<CheckResult[]> {
  return [
    checkInstallKindAndChannel(input),
    checkVersionDrift(input),
    ...(await checkOrchestrator(input)),
    await checkPlaywright(input),
    checkLocalGguf(input),
  ];
}

/** Doctor section. */
export async function runInstallHealthChecks(input: InstallHealthInput): Promise<void> {
  renderSection(INSTALL_HEALTH_SECTION, await collectInstallHealth(input));
}
