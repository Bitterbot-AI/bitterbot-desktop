import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error Experimental JS fixtures have no declaration file.
import { analyze } from "./analyze.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "strategy-analysis-"));
  directories.push(directory);
  const write = (file: string, body: unknown) =>
    writeFileSync(join(directory, file), JSON.stringify(body));
  const protocol = {
    sourceSeeds: [1],
    arms: ["fixed-incumbent", "evolving-incumbent", "fixed-population", "evolving-population"],
    transferDomains: [],
    heldOutCases: 6,
    initialActor: "initial",
    initialProposer: "initial",
  };
  const results = protocol.arms.map((arm) => ({
    name: `source-1-${arm}`,
    tested: { successes: 3, total: 6 },
    baseline: { successes: 2, total: 6 },
    costs: { providerUsd: 0.01 },
  }));
  const complete = {
    phase: "study",
    results,
    provider: { spent: 0.04, reserved: 0, unresolved: 0 },
  };
  const ledger = [
    { type: "intent", id: "one" },
    { type: "receipt", id: "one", usd: 0.04 },
  ];
  const writeLedger = () =>
    writeFileSync(
      join(directory, "provider.jsonl"),
      ledger.map((row) => JSON.stringify(row)).join("\n"),
    );
  write("protocol.json", protocol);
  write("freeze.json", {
    protocolHash: createHash("sha256").update(JSON.stringify(protocol)).digest("hex"),
    sources: [],
  });
  write("complete.json", complete);
  writeLedger();
  return { directory, protocol, complete, ledger, write, writeLedger };
}
it("rejects omitted arms and short final panels rather than reporting a partial success", () => {
  const f = fixture();
  expect(analyze(f.directory).rows).toHaveLength(4);
  f.complete.results[0].tested.total = 5;
  f.write("complete.json", f.complete);
  expect(() => analyze(f.directory)).toThrow("Incomplete final");
  f.complete.results.pop();
  f.write("complete.json", f.complete);
  expect(() => analyze(f.directory)).toThrow("Incomplete assigned");
});
it("rejects protocol changes after the source freeze", () => {
  const f = fixture();
  f.protocol.heldOutCases = 5;
  f.write("protocol.json", f.protocol);
  expect(() => analyze(f.directory)).toThrow("Protocol changed");
});
it("rejects duplicate receipts even if their dollar totals appear consistent", () => {
  const f = fixture();
  f.ledger.push(f.ledger[1]);
  f.writeLedger();
  expect(() => analyze(f.directory)).toThrow("duplicated");
});
it("rejects a node ledger that omits a paid call", () => {
  const f = fixture();
  f.complete.results[0].costs.providerUsd = 0;
  f.write("complete.json", f.complete);
  expect(() => analyze(f.directory)).toThrow("Node/provider cost mismatch");
});
it("allows only numerical roundoff after every intent has a receipt", () => {
  const f = fixture();
  f.complete.provider.reserved = -5.551115123125783e-17;
  f.write("complete.json", f.complete);
  expect(analyze(f.directory).physicalProviderUsd).toBe(0.04);
  f.complete.provider.reserved = 0.001;
  f.write("complete.json", f.complete);
  expect(() => analyze(f.directory)).toThrow("Cost mismatch");
});
