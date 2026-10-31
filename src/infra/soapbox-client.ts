import { withSoapboxOperation } from "./soapbox-transition.js";
/** Versioned adapter to the standalone Soapbox service. Secrets stay in the gateway. */
export type SoapboxPaymentQuote = {
  chain_id: number;
  token: string;
  escrow: string;
  key: string;
  buyer: string;
  operator: string;
  amount_microusdc: number;
  expires: number;
};
export type SoapboxMode =
  | { kind: "paid"; max_cost_credits: number }
  | { kind: "paid_usdc"; max_cost_microusdc: number; operator: string }
  | { kind: "private"; pool_id: string }
  | { kind: "collective"; project_id: string };

export type SoapboxJob = {
  payment?: SoapboxPaymentQuote | null;
  id: string;
  owner: string;
  status: string;
  attempts: number;
  deadline?: number;
  spec: {
    resources?: { cpu_threads: number; memory_mib: number; require_gpu: boolean };
    mode: SoapboxMode;
    workload: {
      kind: "sha256" | "embeddings";
      texts: string[];
      model?: string;
      model_digest?: string;
    };
  };
  result: unknown;
  receipt: unknown;
  error: string | null;
};

export type SoapboxRuntime = {
  model: string;
  model_digest: string;
  version: string;
  model_bytes: number;
  gpu_bytes: number;
  observed_at: number;
};

export type SoapboxGpu = {
  name: string;
  uuid: string;
  driver: string;
  memory_total_mib: number;
  memory_free_mib: number;
  utilization_pct: number;
  temperature_c: number;
};

export type SoapboxWalletStatus = {
  network: "base-sepolia";
  chain_id: 84532;
  address: string | null;
  balance_usdc: string | null;
  per_transaction_usdc: number;
  daily_limit_usdc: number;
  error?: string;
};

export type SoapboxStatus = {
  enabled: boolean;
  active_jobs?: number;
  local_operator?: boolean;
  capabilities?: { mesh_admissions?: boolean };
  api_version?: number;
  settlement?: string;
  principal?: { id: string; roles: string[]; pools: string[]; projects: string[] };
  account?: { available_credits: number; reserved_credits: number; currency: string };
  payment_account?: { chain_id: number; address: string | null };
  nodes?: Array<{
    id: string;
    online: boolean;
    operator_paused: boolean;
    offer: {
      cpu_threads: number;
      memory_mib: number;
      gpu_observed: boolean;
      modes: string[];
      paused: boolean;
      models?: string[];
      pools?: string[];
      projects?: string[];
      runtime?: SoapboxRuntime | null;
      hardware?: SoapboxGpu[];
      gpu_unavailable_reason?: string | null;
      isolation?: string | null;
    };
  }>;
  jobs?: SoapboxJob[];
};

export class SoapboxClient {
  private readonly base: URL;

  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.base = new URL(url);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname);
    if (
      (this.base.protocol !== "https:" && !(this.base.protocol === "http:" && local)) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    ) {
      throw new Error("Soapbox requires a root HTTPS URL, or HTTP on loopback");
    }
    if (token.length < 32) throw new Error("Soapbox token must contain at least 32 characters");
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    const run = () => this.perform<T>(method, path, body, timeoutMs);
    return method === "POST" ? withSoapboxOperation(run) : run();
  }

  private async perform<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!/^\/v1\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error("Invalid Soapbox API path");
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data && Buffer.byteLength(data) > 2 * 1024 * 1024)
      throw new Error("Soapbox request too large");
    const options: RequestInit = {
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method === "GET" && data !== undefined) throw new Error("GET requests cannot have a body");
    const response = await fetch(
      new URL(path, this.base),
      method === "GET" ? { ...options, method: "GET" } : { ...options, method: "POST", body: data },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty Soapbox response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32 * 1024 * 1024) throw new Error("Soapbox response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      const message =
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string"
          ? result.error.slice(0, 300)
          : `HTTP ${response.status}`;
      throw new Error(`Soapbox: ${message}`);
    }
    return result as T;
  }

  async status(timeoutMs = 10_000): Promise<SoapboxStatus> {
    const status = await this.request<SoapboxStatus>("GET", "/v1/status", undefined, timeoutMs);
    if (status.api_version !== 1) throw new Error("Unsupported Soapbox API version");
    return { ...status, enabled: true };
  }
}

export function soapboxClientFromEnv(env: NodeJS.ProcessEnv = process.env): SoapboxClient | null {
  if (env.BITTERBOT_SOAPBOX_ENABLED !== "1") return null;
  const token = env.BITTERBOT_SOAPBOX_TOKEN;
  if (!token) throw new Error("BITTERBOT_SOAPBOX_TOKEN is required");
  return new SoapboxClient(env.BITTERBOT_SOAPBOX_URL ?? "http://127.0.0.1:8787", token);
}
