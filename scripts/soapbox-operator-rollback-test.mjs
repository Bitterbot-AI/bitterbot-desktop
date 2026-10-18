/** Verify rollback of the isolated release profile after all test jobs have completed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const profile = JSON.parse(await readFile(process.argv[2], "utf8"));
assert(profile.root.startsWith("/tmp/soapbox-rc5-operator-"));
const { rollback } = await import(
  pathToFileURL(path.resolve(process.argv[3], "setup/install.mjs"))
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = JSON.parse(await readFile(path.join(profile.target, "before-config.json"), "utf8"));
const result = await rollback(profile.state, profile.target);
assert(result.rolled_back);
const config = JSON.parse(await readFile(profile.configFile, "utf8"));
assert.deepEqual(config.tools, before.tools);
assert.deepEqual(config.p2p, before.p2p);
assert.equal(
  config.plugins?.entries?.["soapbox-compute"],
  before.plugins?.entries?.["soapbox-compute"],
);
assert.equal(
  sha(await readFile(path.join(profile.state, "wallet/untouched-fixture.json"))),
  profile.beforeWalletHash,
);
for (const name of ["entry.js", "babel.cjs"])
  assert.equal(
    sha(await readFile(path.join(profile.app, "dist", name))),
    sha(await readFile(path.join(profile.target, "gateway-before", name))),
  );
const report = {
  test: "activated-operator-rollback",
  passed: true,
  walletUnchanged: true,
  gatewayRestored: true,
  p2pRestored: true,
};
await writeFile(
  path.join(profile.root, "rollback-acceptance.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
