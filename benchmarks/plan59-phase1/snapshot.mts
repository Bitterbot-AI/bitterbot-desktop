/**
 * PLAN-59 Phase 1: seal a snapshot.
 *
 *   node --no-warnings --import tsx benchmarks/plan59-phase1/snapshot.mts \
 *     (--copy-from ~/.bitterbot/memory/main.sqlite | --db <existing copy>) \
 *     --out <scratch>/snapshot.sqlite
 *
 * `--copy-from` opens the live store READ-ONLY and takes a `VACUUM INTO` copy;
 * `--db` copies an existing copy the same way. The output and its manifest
 * (`<out>.manifest.json`: SHA-256, chunk count, created time, commit) are
 * refused anywhere under ~/.bitterbot. Nothing else is written.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  gitCommit,
  isUnderBitterbotHome,
  refuseUnderBitterbotHome,
  sha256File,
  vacuumInto,
} from "./common.js";

const { values: args } = parseArgs({
  options: {
    "copy-from": { type: "string" },
    db: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});
if ((!args["copy-from"] && !args.db) || !args.out) {
  throw new Error("usage: (--copy-from <live sqlite> | --db <copy>) --out <snapshot.sqlite>");
}
const src = resolve(args["copy-from"] ?? args.db!);
const out = resolve(args.out);
refuseUnderBitterbotHome(out, "a snapshot");
if (args.db && isUnderBitterbotHome(args.db)) {
  throw new Error(
    "--db must point at a copy outside ~/.bitterbot; use --copy-from for the live store",
  );
}
if (existsSync(out)) {
  throw new Error(`snapshot exists: ${out}`);
}
mkdirSync(dirname(out), { recursive: true });
const copy = vacuumInto(src, out);
const ro = new DatabaseSync(out, { readOnly: true });
const chunks = Number((ro.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c);
const schema = (
  ro.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
)?.value;
const lifecycle = ro
  .prepare(
    `SELECT COALESCE(lifecycle, 'generated') AS lc, COUNT(*) AS c FROM chunks GROUP BY lc ORDER BY lc`,
  )
  .all() as unknown as Array<{ lc: string; c: number }>;
ro.close();
const manifest = {
  createdAt: new Date().toISOString(),
  snapshot: out,
  sourceKind: args["copy-from"] ? "live-readonly-vacuum-into" : "copy-vacuum-into",
  sha256: sha256File(out),
  bytes: copy.bytes,
  vacuumMs: Number(copy.ms.toFixed(1)),
  chunks,
  schemaVersion: schema ? Number(schema) : null,
  lifecycle: Object.fromEntries(lifecycle.map((r) => [r.lc, Number(r.c)])),
  gitCommit: gitCommit(),
};
writeFileSync(`${out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
