/**
 * PLAN-41 Phase 1 (p0-7): a stable, repo-independent home for the node's
 * libp2p Ed25519 identity.
 *
 * History: the TS side only passed `--key-dir` when `p2p.keyDir` was set, so
 * the Rust orchestrator fell back to `./keys` RELATIVE TO ITS CWD — a repo
 * checkout for `pnpm start gateway`, `$HOME` under systemd, `/` under
 * launchd. Identities ended up scattered (`<repo>/keys`,
 * `<repo>/desktop/keys`, `~/keys`) and a moved checkout silently minted a
 * fresh peer identity. The default is now `~/.bitterbot/keys` (which
 * `bitterbot reset`/`uninstall` already wipe with the state dir, and which
 * docs/gateway/configuration-reference.md has claimed all along), `--key-dir`
 * is always passed, and legacy locations are migrated on start.
 *
 * The keypair IS the node identity: for management nodes it is also the
 * signing authority for census/anomaly/bans. Migration COPIES and never
 * deletes: the canonical dir wins on every subsequent boot (existing target
 * always short-circuits), the legacy dir gets a MIGRATED.txt marker and is
 * simply never read again, and — decisive — no crash, test harness, or
 * partial failure can ever destroy the only copy of an identity key. A
 * management node with no key anywhere refuses to boot rather than silently
 * regenerating a keypair the genesis trust list has never heard of.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("p2p/key-dir");

/** The identity pair itself. */
const KEY_FILES = ["node.key", "node.pub"] as const;
/** Files the orchestrator resolves relative to the key dir; travel together. */
const COLOCATED_FILES = ["genesis_trust_list.txt", "bootnode-peers.json"] as const;

export function defaultP2pKeyDir(homedir: string = os.homedir()): string {
  return path.join(homedir, ".bitterbot", "keys");
}

/** Explicit `p2p.keyDir` (with `~` expansion) wins; otherwise the stable default. */
export function resolveP2pKeyDir(keyDir: string | undefined, homedir?: string): string {
  const trimmed = keyDir?.trim();
  if (trimmed) {
    return resolveUserPath(trimmed);
  }
  return defaultP2pKeyDir(homedir);
}

export type LegacyKeyMigration = { migratedFrom: string; files: string[] };

/**
 * Copy an identity from the first legacy location that has one into
 * `targetDir`. No-op when the target already holds a `node.key` (existing
 * identity always wins) or when no legacy key exists (first boot: the
 * orchestrator generates fresh keys in the target). Never overwrites a file
 * that already exists in the target, and never deletes the source.
 */
export function migrateLegacyP2pKeys(params: {
  targetDir: string;
  packageRoot?: string | null;
  homedir?: string;
}): LegacyKeyMigration | null {
  const { targetDir } = params;
  const homedir = params.homedir ?? os.homedir();
  const root = params.packageRoot ?? process.cwd();
  if (fs.existsSync(path.join(targetDir, "node.key"))) {
    return null;
  }

  const candidates = [
    path.join(root, "keys"),
    path.join(root, "desktop", "keys"),
    path.join(homedir, "keys"),
  ].filter((dir) => path.resolve(dir) !== path.resolve(targetDir));

  const source = candidates.find((dir) => fs.existsSync(path.join(dir, "node.key")));
  if (!source) {
    return null;
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of [...KEY_FILES, ...COLOCATED_FILES]) {
    const from = path.join(source, name);
    const to = path.join(targetDir, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) {
      continue;
    }
    fs.copyFileSync(from, to);
    if (name === "node.key") {
      fs.chmodSync(to, 0o600);
    }
    moved.push(name);
  }
  fs.writeFileSync(
    path.join(source, "MIGRATED.txt"),
    `P2P identity copied to ${targetDir} on ${new Date().toISOString()} (PLAN-41 p0-7).\n` +
      `This directory is no longer read; once you have verified the node boots\n` +
      `with its old peer ID, it is safe to delete.\n`,
  );
  log.info(`migrated P2P identity ${source} -> ${targetDir} (${moved.join(", ")})`);
  return { migratedFrom: source, files: moved };
}

/**
 * A management node's keypair is its authority; regenerating one silently
 * would strand it outside its own genesis trust list. Refuse to boot instead.
 */
export function assertManagementKeyPresent(params: {
  targetDir: string;
  nodeTier: string | undefined;
}): void {
  if ((params.nodeTier ?? "edge") !== "management") {
    return;
  }
  if (!fs.existsSync(path.join(params.targetDir, "node.key"))) {
    throw new Error(
      `Management node has no identity keypair at ${params.targetDir} (node.key missing) ` +
        `and no legacy key dir was found to migrate. Refusing to mint a fresh identity: ` +
        `the keypair is the management authority. Restore the key files or set p2p.keyDir ` +
        `to the directory that holds them.`,
    );
  }
}
