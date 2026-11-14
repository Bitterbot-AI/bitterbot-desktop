import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../../../src/config/config.js";
import {
  repo,
  root,
  suite,
  exported,
  hash,
  cap,
  settings,
  exec,
  read,
  write,
  copyJson,
  sources,
  sha256,
} from "./common.js";
export { repo, root, suite, exported, read, write, copyJson };
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const [{ learningHash }, { StudyLedger }, { CollectiveSkillStore }, { isolatedPackageConfig }] =
  await Promise.all([
    import("../../../src/agents/skills/collective/contracts.js"),
    import("../../../benchmarks/collective-learning/study-ledger.js"),
    import("../../../src/agents/skills/collective/store.js"),
    import("../../../src/agents/skills/collective/isolated-config.js"),
  ]);
export type Cost = { providerUsd: number; toolCalls: number; wallMs: number };
export type Fixture = {
  id: string;
  partition: string;
  genre?: string;
  directory: string;
  missing?: string | null;
  files: Record<string, string>;
};
export const frozen = await read<{
  hash: string;
  sources: Record<string, string>;
  image: string;
  configHash: string;
  quote: Cost;
  retentionNotBefore: number;
  contract: { instructions: string };
  inherited: { knownUsd: number; reserveUsd: number; remainingUsd: number };
  environment: unknown;
  settings: typeof settings;
}>(path.join(root, "frozen.json"));
const { hash: freezeHash, ...body } = frozen;
assert.equal(learningHash(body), freezeHash);
assert.deepEqual(await sources(), frozen.sources, "Frozen implementation changed");
export const config = await read<BitterbotConfig>(path.join(root, "state/bitterbot.json"));
assert.equal(learningHash(config), frozen.configHash);
export const contract = frozen.contract;
const inventory = await read<Omit<Fixture, "directory">[]>(
  path.join(suite, "fixtures/inventory.json"),
);
const original = path.join(repo, "research/collective-learning/executable-learning");
const old = await read<{
  partitions: Array<{
    id: string;
    partition: string;
    files: Array<{ path: string; sha256: string }>;
  }>;
}>(path.join(original, "fixtures/inventory.json"));
export const fixtures: Fixture[] = [
  ...inventory.map((f) => ({ ...f, directory: path.join(suite, "fixtures", f.partition, f.id) })),
  ...old.partitions
    .filter((f) => f.partition === "evaluation")
    .map((f) => ({
      id: "regression-" + f.id,
      partition: "regression",
      directory: path.join(original, "fixtures/evaluation", f.id),
      files: Object.fromEntries(f.files.map((v) => [path.basename(v.path), v.sha256])),
    })),
];
for (const f of fixtures)
  for (const [name, digest] of Object.entries(f.files))
    assert.equal(sha256(await fs.readFile(path.join(f.directory, name))), digest);
export const db = new DatabaseSync(path.join(root, "ledger.sqlite"));
export const ledger = new StudyLedger(db, cap);
const packageDb = new DatabaseSync(path.join(root, "recipient.sqlite"));
export const packages = new CollectiveSkillStore(packageDb, path.join(root, "recipient-packages"));
assert.equal((await packages.read(hash)).packageHash, hash);
export const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
export function recipientConfig(...args: Parameters<typeof isolatedPackageConfig>) {
  const c = isolatedPackageConfig(...args);
  Object.assign(c.agents!.defaults!.sandbox!.docker!, settings);
  return c;
}
export function budget() {
  const rows = db.prepare("SELECT state,body,cost FROM study_charges").all() as Array<{
    state: string;
    body: string;
    cost: string | null;
  }>;
  const knownUsd = rows.reduce(
    (n, r) => n + (r.cost ? (JSON.parse(r.cost) as Cost).providerUsd : 0),
    0,
  );
  const heldUsd = rows.reduce(
    (n, r) => n + (r.cost ? 0 : (JSON.parse(r.body) as { quote: Cost }).quote.providerUsd),
    0,
  );
  return {
    knownUsd,
    heldUsd,
    unresolved: rows.filter((r) => r.state !== "settled").length,
    stageRemainingUsd: cap.providerUsd - knownUsd - heldUsd,
    cumulativeKnownUsd: frozen.inherited.knownUsd + knownUsd,
    priorReserveUsd: frozen.inherited.reserveUsd,
    remainingUsd: frozen.inherited.remainingUsd - knownUsd - heldUsd,
  };
}
export function settle(
  id: string,
  cost: Cost | null,
  tokens: number,
  artifact: unknown,
  success: boolean | null = null,
  phase = "final",
) {
  ledger.finish(
    id,
    {
      taskId: id,
      family: "docx-placeholder-transfer",
      node: "b",
      user: "authored-recipient-study",
      environment: learningHash(frozen.environment),
      condition: "local",
      phase,
      success,
      checked: success !== null,
      criticalFailure: false,
      retention: id.startsWith("retention-"),
      freshSession: true,
      elapsedHours: id.startsWith("retention-")
        ? (Date.now() - (frozen.retentionNotBefore - 86400000)) / 3600000
        : 0,
      newUser: false,
      cost,
      tokens,
      latencyMs: cost?.wallMs ?? 0,
      humanUsefulness: null,
      humanRecommendation: null,
    },
    artifact,
  );
}
export async function cleanContainers() {
  const registry = await read<{ entries: Array<{ containerName: string }> }>(
    path.join(root, "state/sandbox/containers.json"),
  ).catch(() => ({ entries: [] }));
  for (const entry of registry.entries) {
    assert(/^bitterbot-sbx-/.test(entry.containerName));
    const inspected = await exec("docker", ["inspect", entry.containerName], {
      maxBuffer: 1024 * 1024,
    }).catch(() => null);
    if (!inspected) continue;
    const info = JSON.parse(inspected.stdout)[0];
    assert.equal(info.Image, frozen.image);
    assert.equal(info.Config.Labels["bitterbot.sandbox"], "1");
    assert(info.Mounts.some((m: { Source: string }) => m.Source.startsWith(root + "/")));
    await exec("docker", ["rm", "-f", entry.containerName]);
  }
}
