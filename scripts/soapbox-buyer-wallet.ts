/** Run locally by a buyer. Prints only the new test account's public address. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createSoapboxWallet } from "../src/services/soapbox-wallet.js";

async function main() {
  const file = process.argv[2] ?? path.join(homedir(), ".bitterbot/bitterbot.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const wallet = await createSoapboxWallet(config.tools?.wallet);
  console.log(
    JSON.stringify(
      { network: "base-sepolia", chain_id: 84532, address: await wallet.getAddress() },
      null,
      2,
    ),
  );
}
void main().catch(() => {
  console.error(
    "Test wallet initialization failed. Check your local CDP configuration and network connection; do not share wallet secrets.",
  );
  process.exitCode = 1;
});
