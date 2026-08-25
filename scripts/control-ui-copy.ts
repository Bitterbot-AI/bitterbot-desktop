import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * PLAN-39 Phase 1: stage the built Control UI where the gateway can serve it.
 *
 * Copies `desktop/dist-renderer` to `dist/control-ui`. Modelled on
 * `scripts/canvas-a2ui-copy.ts`, with two behaviours that copy does not have:
 *
 * 1. N-1 asset retention. The point of gateway-serving is that a UI update needs
 *    no restart, which is exactly the case with no reload trigger. An open tab
 *    holds the previous `index.html`; if this step purged the old content-hashed
 *    chunks, every lazy import in that tab would 404 mid-session with nothing
 *    prompting a reload. So we keep the previous generation's assets and prune
 *    only older ones. Costs ~12 MB of disk and makes the race impossible.
 *
 * 2. A gateway-token guard. `desktop/vite.config.ts` currently bakes the gateway
 *    token into the bundle via `define`. Anything staged here is destined to be
 *    served over HTTP, so publishing a token-bearing bundle would hand the
 *    gateway credential to any client that fetches the JS. Until the define is
 *    removed (Phase 3), refuse to stage such a build rather than serve it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GENERATIONS_FILE = ".control-ui-generations.json";
/** Keep the current generation plus this many previous ones. */
const RETAINED_PREVIOUS_GENERATIONS = 1;

export function getControlUiPaths(env = process.env) {
  const srcDir =
    env.BITTERBOT_CONTROL_UI_SRC_DIR ?? path.join(repoRoot, "desktop", "dist-renderer");
  const outDir = env.BITTERBOT_CONTROL_UI_OUT_DIR ?? path.join(repoRoot, "dist", "control-ui");
  return { srcDir, outDir };
}

/** Repo-relative paths of every file under `dir`, POSIX-separated. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Read the gateway token from the environment or the on-disk config, if any.
 * Returns null when there is nothing to check against, which is the normal case
 * in CI.
 */
export async function readGatewayTokenForGuard(env = process.env): Promise<string | null> {
  const fromEnv = env.BITTERBOT_GATEWAY_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const stateDir = env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
  try {
    const raw = await fs.readFile(path.join(stateDir, "bitterbot.json"), "utf8");
    const parsed = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } };
    const token = parsed.gateway?.auth?.token;
    return typeof token === "string" && token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

/** Throws when a staged file embeds the live gateway token. */
export async function assertNoEmbeddedToken(params: {
  srcDir: string;
  files: string[];
  token: string | null;
}): Promise<void> {
  if (!params.token) {
    return;
  }
  for (const rel of params.files) {
    if (!/\.(js|mjs|cjs|html|json|map|css)$/i.test(rel)) {
      continue;
    }
    const contents = await fs.readFile(path.join(params.srcDir, rel), "utf8").catch(() => "");
    if (contents.includes(params.token)) {
      throw new Error(
        `Refusing to stage the Control UI: ${rel} embeds the gateway auth token.\n` +
          "Anything staged here is served over HTTP, so this would publish the gateway\n" +
          "credential to every client that fetches the bundle. Remove the\n" +
          "VITE_GATEWAY_TOKEN define in desktop/vite.config.ts (PLAN-39 Phase 3 /\n" +
          "PLAN-37 item 13) and rebuild the renderer.",
      );
    }
  }
}

export async function copyControlUiAssets(params: {
  srcDir: string;
  outDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ copied: number; pruned: number } | null> {
  const env = params.env ?? process.env;
  const skipMissing = env.BITTERBOT_CONTROL_UI_SKIP_MISSING === "1";

  try {
    await fs.stat(path.join(params.srcDir, "index.html"));
  } catch (err) {
    const message =
      'Missing Control UI build output. Run "pnpm ui:build" (or "pnpm --dir desktop build") and retry.';
    if (skipMissing) {
      console.warn(`${message} Skipping copy (BITTERBOT_CONTROL_UI_SKIP_MISSING=1).`);
      return null;
    }
    throw new Error(message, { cause: err });
  }

  const files = await listFiles(params.srcDir);
  await assertNoEmbeddedToken({
    srcDir: params.srcDir,
    files,
    token: await readGatewayTokenForGuard(env),
  });

  // Copy over the top. Deliberately NOT a wipe-and-replace: see the N-1 note above.
  await fs.mkdir(params.outDir, { recursive: true });
  for (const rel of files) {
    const dest = path.join(params.outDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(params.srcDir, rel), dest);
  }

  // Track generations so we can prune anything older than the previous build.
  const generationsPath = path.join(params.outDir, GENERATIONS_FILE);
  let previous: string[][] = [];
  try {
    const raw = await fs.readFile(generationsPath, "utf8");
    const parsed = JSON.parse(raw) as { generations?: unknown };
    if (Array.isArray(parsed.generations)) {
      previous = parsed.generations.filter(
        (g): g is string[] => Array.isArray(g) && g.every((f) => typeof f === "string"),
      );
    }
  } catch {
    // No manifest yet (first run, or an older layout): treat everything on disk as
    // the previous generation so the first prune cannot delete a live asset.
    const existing = (await listFiles(params.outDir)).filter((f) => f !== GENERATIONS_FILE);
    previous = existing.length ? [existing] : [];
  }

  const generations = [files, ...previous].slice(0, RETAINED_PREVIOUS_GENERATIONS + 1);
  const keep = new Set(generations.flat());
  keep.add(GENERATIONS_FILE);

  let pruned = 0;
  for (const rel of await listFiles(params.outDir)) {
    if (keep.has(rel)) {
      continue;
    }
    await fs.rm(path.join(params.outDir, rel), { force: true });
    pruned += 1;
  }

  await fs.writeFile(generationsPath, `${JSON.stringify({ generations }, null, 2)}\n`, "utf8");
  return { copied: files.length, pruned };
}

async function main() {
  const { srcDir, outDir } = getControlUiPaths();
  const result = await copyControlUiAssets({ srcDir, outDir });
  if (result) {
    console.log(
      `[control-ui-copy] staged ${result.copied} file(s) to ${path.relative(repoRoot, outDir)}` +
        (result.pruned ? `, pruned ${result.pruned} stale file(s)` : ""),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
