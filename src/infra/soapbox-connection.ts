import { SoapboxClient, type SoapboxStatus } from "./soapbox-client.js";

/** Portable enrollment file. Contains one scoped API token, never wallet signing keys. */
export type SoapboxConnection = {
  version: 1;
  role: "buyer" | "operator";
  id: string;
  url: string;
  token: string;
  address: string;
  chain_id: 84532;
  escrow: string;
  escrow_code_sha256: string;
  rpc_url: string;
};
export function parseSoapboxConnection(value: unknown): SoapboxConnection {
  const c = value as Partial<SoapboxConnection> | null;
  if (
    !c ||
    c.version !== 1 ||
    !["buyer", "operator"].includes(c.role ?? "") ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(c.id ?? "") ||
    c.chain_id !== 84532 ||
    !/^0x[\da-f]{40}$/i.test(c.address ?? "") ||
    /^0x0{40}$/i.test(c.address ?? "") ||
    !/^0x[\da-f]{40}$/i.test(c.escrow ?? "") ||
    !/^[\da-f]{64}$/i.test(c.escrow_code_sha256 ?? "") ||
    typeof c.url !== "string" ||
    typeof c.token !== "string" ||
    typeof c.rpc_url !== "string"
  )
    throw new Error("Invalid Base Sepolia enrollment file");
  new SoapboxClient(c.url, c.token);
  if (!["https://sepolia.base.org", "https://sepolia.base.org/"].includes(c.rpc_url))
    throw new Error("Enrollment must use the public Base Sepolia RPC endpoint");
  return c as SoapboxConnection;
}
export function verifySoapboxConnection(c: SoapboxConnection, s: SoapboxStatus): void {
  const role = c.role === "operator" ? "worker" : "submitter";
  if (
    s.principal?.id !== c.id ||
    !s.principal.roles.includes(role) ||
    s.principal.roles.includes("admin") ||
    s.principal.roles.some((r) => r !== role) ||
    s.payment_account?.chain_id !== 84532 ||
    s.payment_account.address?.toLowerCase() !== c.address.toLowerCase()
  )
    throw new Error(
      "Coordinator identity, role, or testnet payout address does not match enrollment",
    );
}

export function soapboxOperatorEnvironment(
  token: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { SOAPBOX_WORKER_TOKEN: token };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "XDG_RUNTIME_DIR"])
    if (env[key]) result[key] = env[key];
  return result;
}
