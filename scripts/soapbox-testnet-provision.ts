/** Create isolated Base Sepolia pilot accounts using the configured CDP project. Never changes the live wallet. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const configPath =
  process.env.BITTERBOT_CONFIG_PATH ?? path.join(os.homedir(), ".bitterbot", "bitterbot.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const wallet = config.tools?.wallet ?? {};
const client = new CdpClient({
  apiKeyId: wallet.cdpApiKeyId ?? process.env.CDP_API_KEY_ID,
  apiKeySecret: wallet.cdpApiKeySecret ?? process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});
const rpc = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const accounts: Record<string, string> = {};
for (const role of ["buyer", "operator", "settler"] as const) {
  const account = await client.evm.getOrCreateAccount({
    name: role === "buyer" ? "bitterbot-owner-base-sepolia" : `soapbox-phase2-${role}`,
  });
  accounts[role] = account.address;
  const eth = await rpc.getBalance({ address: account.address });
  const usdc = await rpc.readContract({
    address: token,
    abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(
    JSON.stringify({
      role,
      address: account.address,
      chainId: 84532,
      ethWei: eth.toString(),
      microusdc: usdc.toString(),
    }),
  );
  if (role !== "operator" && eth < 100_000_000_000_000n) {
    const result = await client.evm.requestFaucet({
      address: account.address,
      network: "base-sepolia",
      token: "eth",
    });
    console.log(JSON.stringify({ role, faucet: "eth", transactionHash: result.transactionHash }));
    await rpc.waitForTransactionReceipt({ hash: result.transactionHash });
  }
  if (role === "buyer" && usdc < 1_000_000n) {
    const result = await client.evm.requestFaucet({
      address: account.address,
      network: "base-sepolia",
      token: "usdc",
    });
    console.log(JSON.stringify({ role, faucet: "usdc", transactionHash: result.transactionHash }));
    await rpc.waitForTransactionReceipt({ hash: result.transactionHash });
  }
}
const output = process.env.SOAPBOX_TESTNET_ACCOUNTS;
if (!output || !path.isAbsolute(output))
  throw new Error("Set SOAPBOX_TESTNET_ACCOUNTS to an absolute output path");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(accounts, null, 2), { mode: 0o600 });
