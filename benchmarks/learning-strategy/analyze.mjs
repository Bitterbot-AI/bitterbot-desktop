import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function analyze(root) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const freeze = read("freeze.json"),
    complete = read("complete.json"),
    protocol = read("protocol.json");
  if (createHash("sha256").update(JSON.stringify(protocol)).digest("hex") !== freeze.protocolHash)
    throw Error("Protocol changed");
  for (const source of freeze.sources)
    if (
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, source.snapshot)))
        .digest("hex") !== source.sha256
    )
      throw Error("Source snapshot changed");
  const ledger = fs
    .readFileSync(path.join(root, "provider.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const receipts = new Map(ledger.filter((r) => r.type === "receipt").map((r) => [r.id, r]));
  const intents = ledger.filter((r) => r.type === "intent");
  if (
    new Set(intents.map((r) => r.id)).size !== intents.length ||
    ledger.filter((r) => r.type === "receipt").length !== receipts.size ||
    intents.some((r) => !receipts.has(r.id)) ||
    receipts.size !== intents.length
  )
    throw Error("Unresolved or duplicated provider receipts");
  const usd = [...receipts.values()].reduce((s, r) => s + r.usd, 0);
  if (
    Math.abs(usd - complete.provider.spent) > 1e-8 ||
    complete.provider.unresolved ||
    !Number.isFinite(complete.provider.reserved) ||
    Math.abs(complete.provider.reserved) > 1e-10
  )
    throw Error("Cost mismatch");
  const rows = complete.results.map((r) => ({
    name: r.name ?? r.domain,
    successes: r.tested?.successes ?? r.successes,
    total: r.tested?.total ?? r.total,
    baselineSuccesses: r.baseline?.successes,
    baselineTotal: r.baseline?.total,
    providerUsd: r.costs?.providerUsd ?? r.cost.providerUsd,
    sourceDiscoveryAllocationUsd: r.sourceDiscoveryAllocationUsd ?? 0,
    selected: r.selected?.strategy,
    actorChanged:
      r.strategy?.actor !== undefined ? r.strategy.actor !== protocol.initialActor : undefined,
    proposerChanged:
      r.strategy?.proposer !== undefined
        ? r.strategy.proposer !== protocol.initialProposer
        : undefined,
  }));
  const result = {
    phase: complete.phase,
    rows,
    physicalProviderUsd: usd,
    calls: receipts.size,
    sourceGate: complete.sourceGate,
    interpretation:
      "Exploratory synthetic results. Two source search replicates; no significance, broad transfer, native mesh, retention or production efficacy claim.",
  };
  if (complete.phase === "study") {
    const expected = protocol.sourceSeeds
      .flatMap((seed) => protocol.arms.map((arm) => `source-${seed}-${arm}`))
      .concat(
        protocol.transferDomains.flatMap(({ domain, version }) =>
          ["fresh-proposer", "transferred-proposer"].map(
            (arm) => `recipient-${domain}-${version}-${arm}`,
          ),
        ),
      );
    if (
      rows.length !== expected.length ||
      new Set(rows.map((r) => r.name)).size !== expected.length ||
      expected.some((name) => !rows.some((r) => r.name === name))
    )
      throw Error("Incomplete assigned arms");
    if (
      rows.some(
        (r) => r.total !== protocol.heldOutCases || r.baselineTotal !== protocol.heldOutCases,
      )
    )
      throw Error("Incomplete final panels");
    if (Math.abs(rows.reduce((s, r) => s + r.providerUsd, 0) - usd) > 1e-8)
      throw Error("Node/provider cost mismatch");
    const contrasts = [];
    for (const seed of protocol.sourceSeeds)
      for (const selection of ["incumbent", "population"]) {
        const fixed = rows.find((r) => r.name === `source-${seed}-fixed-${selection}`),
          evolved = rows.find((r) => r.name === `source-${seed}-evolving-${selection}`);
        contrasts.push({
          seed,
          selection,
          successDifference: evolved.successes / evolved.total - fixed.successes / fixed.total,
          costDifference: evolved.providerUsd - fixed.providerUsd,
        });
      }
    result.contrasts = contrasts;
  }
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve("benchmarks/learning-strategy/analyze.mjs")
) {
  const root = path.resolve(process.argv[2]);
  const result = analyze(root);
  fs.writeFileSync(path.join(root, "analysis.json"), JSON.stringify(result, null, 2), {
    flag: "wx",
  });
  console.log(JSON.stringify(result, null, 2));
}
