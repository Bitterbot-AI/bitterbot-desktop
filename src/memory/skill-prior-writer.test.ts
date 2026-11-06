import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillPriorLedger } from "../agents/skills/skill-prior-runtime.js";
import { SkillPriorLedger, emptyLedgerState } from "../agents/skills/skill-prior.js";
import type { SkillPriorCredit } from "./skill-prior-outcome.js";
import {
  applySkillPriorCredits,
  LIVE_PRIOR_CAPACITY,
  readLivePriorCredits,
  rebuildLivePrior,
  writeBenchmarkSkillPriorLedger,
  writerOptions,
} from "./skill-prior-writer.js";

const options = writerOptions();
function credit(n: number, outcome: 0 | 1 = 1): SkillPriorCredit {
  return {
    runId: "run-" + n,
    skill: { name: "format", hash: "a".repeat(64) },
    outcome,
    startedAt: 1000 + n,
    source: "task-checks",
    revision: "task:" + n,
    signalOrder: n,
    author: "model",
  };
}
describe("durable verified outcome writer", () => {
  let dir: string, file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "prior-writer-"));
    file = path.join(dir, "prior.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const apply = (file: string, credits: SkillPriorCredit[]) =>
    applySkillPriorCredits({ file, credits, mode: "on", options });

  it("shadow and off do not create any file or directory", async () => {
    const target = path.join(dir, "absent", "prior.json");
    expect(
      (
        await applySkillPriorCredits({
          file: target,
          credits: [credit(1)],
          mode: "shadow",
          options,
        })
      ).changes[0].action,
    ).toBe("insert");
    await applySkillPriorCredits({ file: target, credits: [credit(1)], mode: "off", options });
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("rebuild equals incremental updates, including out-of-order arrival", async () => {
    const credits = Array.from({ length: 40 }, (_, i) => credit(i, i % 3 ? 1 : 0));
    const incremental = new SkillPriorLedger(undefined, options);
    for (const c of credits)
      incremental.update({ ...c, cell: "default", gate: true, verified: true });
    const rebuilt = await rebuildLivePrior(credits.toReversed(), options);
    expect(SkillPriorLedger.fromJSON(JSON.stringify(rebuilt)).toJSON()).toBe(incremental.toJSON());
    await apply(file, credits.slice(10));
    await apply(file, credits.slice(0, 10));
    expect(SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8")).toJSON()).toBe(
      incremental.toJSON(),
    );
  });
  it("restarts dedupe, and a human reversal replaces one original observation exactly", async () => {
    const credits = [credit(1), credit(2, 0), credit(3)];
    await apply(file, credits);
    const original = await fs.readFile(file, "utf8");
    expect((await apply(file, credits)).written).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    const corrected: SkillPriorCredit = {
      ...credits[0],
      outcome: 0,
      source: "owner-feedback",
      revision: "human-1",
      signalOrder: 1,
      author: "operator",
    };
    await apply(file, [corrected]);
    const expected = await rebuildLivePrior([corrected, ...credits.slice(1)], options);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
    expect(
      SkillPriorLedger.fromJSON(JSON.stringify(expected)).verifiedEvidence(
        "default",
        corrected.skill,
      ),
    ).toEqual({ passed: 1, runs: 3 });
    expect((await apply(file, [credits[0]])).changes[0].action).toBe("stale");
  });
  it("preserves durable dedupe beyond the core 5000-entry window and stops at capacity", async () => {
    const credits = Array.from({ length: LIVE_PRIOR_CAPACITY }, (_, i) => credit(i));
    await apply(file, credits);
    const retry = await apply(file, [credit(0), credit(LIVE_PRIOR_CAPACITY)]);
    expect(retry.changes.map((c) => c.action)).toEqual(["duplicate", "capacity"]);
    expect((await readLivePriorCredits(file, options)).length).toBe(LIVE_PRIOR_CAPACITY);
    const reversal: SkillPriorCredit = {
      ...credit(0),
      outcome: 0,
      source: "owner-feedback",
      revision: "human",
      signalOrder: 1,
      author: "operator",
    };
    expect((await apply(file, [reversal])).changes[0].action).toBe("replace");
    expect(
      SkillPriorLedger.fromJSON(await fs.readFile(file, "utf8")).verifiedEvidence(
        "default",
        reversal.skill,
      ),
    ).toEqual({ passed: LIVE_PRIOR_CAPACITY - 1, runs: LIVE_PRIOR_CAPACITY });
  }, 20_000);
  it("serializes concurrent aliases; files are 0600 and mtime invalidates the runtime cache", async () => {
    const alias = path.join(dir, "alias");
    await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
    await Promise.all([
      apply(file, [credit(1)]),
      apply(path.join(alias, "prior.json"), [credit(2)]),
    ]);
    expect((await readLivePriorCredits(file, options)).length).toBe(2);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const cfg = { skills: { prior: { ledgerPath: file } } };
    const before = loadSkillPriorLedger(cfg).verifiedEvidence("default", credit(1).skill);
    const stamp = (await fs.stat(file)).mtimeMs;
    await apply(file, [credit(3, 0)]);
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(stamp);
    expect(loadSkillPriorLedger(cfg).verifiedEvidence("default", credit(1).skill)).not.toEqual(
      before,
    );
  });
  it("leaves the previous ledger intact if atomic rename fails, and removes its temporary file", async () => {
    await apply(file, [credit(1)]);
    const original = await fs.readFile(file, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected rename failure"));
    await expect(apply(file, [credit(2)])).rejects.toThrow("rename failure");
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(await fs.readdir(dir)).toEqual(["prior.json"]);
  });
  it.each([
    "{broken",
    JSON.stringify({ ...emptyLedgerState(), scope: "benchmark" }),
    JSON.stringify({ ...emptyLedgerState(), seen: ["old|skill"] }),
  ])("refuses unsafe existing ledgers without changing them", async (raw) => {
    await fs.writeFile(file, raw);
    await expect(apply(file, [credit(1)])).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });
  it("refuses a corrupted projection even after an earlier validated read", async () => {
    await apply(file, [credit(1)]);
    await readLivePriorCredits(file, options);
    const altered = JSON.parse(await fs.readFile(file, "utf8"));
    altered.cells.default.format.n = 99;
    const raw = JSON.stringify(altered);
    await fs.writeFile(file, raw);
    await expect(apply(file, [credit(2)])).rejects.toThrow("projection disagrees");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });
  it("accepts empty legacy state but refuses parameter drift and changed attribution", async () => {
    await fs.writeFile(file, JSON.stringify(emptyLedgerState()));
    await apply(file, [credit(1)]);
    await expect(
      applySkillPriorCredits({
        file,
        mode: "on",
        credits: [credit(2)],
        options: { ...options, discount: 1 },
      }),
    ).rejects.toThrow("parameters changed");
    await expect(
      apply(file, [{ ...credit(1), skill: { name: "different", hash: "b".repeat(64) } }]),
    ).rejects.toThrow("attribution");
  });
  it("prevents benchmark/live collisions in both directions and marks benchmark state", async () => {
    const bench = path.join(dir, "bench.json");
    await expect(
      writeBenchmarkSkillPriorLedger(file, new SkillPriorLedger(), file),
    ).rejects.toThrow("collides");
    await apply(file, [credit(1)]);
    await expect(
      writeBenchmarkSkillPriorLedger(file, new SkillPriorLedger(), bench),
    ).rejects.toThrow("live writer");
    await writeBenchmarkSkillPriorLedger(bench, new SkillPriorLedger(), file);
    expect(JSON.parse(await fs.readFile(bench, "utf8")).scope).toBe("benchmark");
    await expect(apply(bench, [credit(1)])).rejects.toThrow("benchmark");
  });
});
