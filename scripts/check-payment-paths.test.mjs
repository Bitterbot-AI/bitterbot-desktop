import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

await test("payment lint catches raw CDP signing and Compute funding outside reviewed entrypoints", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bitterbot-payment-lint-"));
  try {
    mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src", "unreviewed.ts");
    for (const source of [
      "wallet.fundSoapbox!(quote)",
      "wallet.fundSoapbox(quote)",
      "cdp.evm.sendTransaction(transaction)",
    ]) {
      writeFileSync(file, source);
      const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "check-payment-paths.mjs")],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unreviewed.ts/);
    }
    writeFileSync(file, "wallet.getBalance()");
    assert.equal(
      spawnSync(process.execPath, [path.join(import.meta.dirname, "check-payment-paths.mjs")], {
        cwd: root,
      }).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
