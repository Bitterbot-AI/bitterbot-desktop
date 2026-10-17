import JSON5 from "json5";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../config/types.js";
import type { WalletConfig } from "../config/types.wallet.js";
import type { SoapboxSetupStatus } from "../infra/soapbox-setup-types.js";
import { SoapboxClient } from "../infra/soapbox-client.js";
import {
  parseSoapboxConnection,
  verifySoapboxConnection,
  type SoapboxConnection,
} from "../infra/soapbox-connection.js";
import { SOAPBOX_SETUP_RELEASE, SoapboxSetupRuntime } from "./soapbox-setup-runtime.js";
import {
  initializeSoapboxWallet,
  soapboxWalletAuthentication,
  soapboxWalletIdentity,
  type SoapboxWalletAuthentication,
} from "./soapbox-wallet.js";

export class SoapboxSetup {
  readonly runtime: SoapboxSetupRuntime;
  private enrollment?: SoapboxConnection;
  private busy = false;
  private activated = false;
  constructor(
    private options: {
      root: string;
      configPath: string;
      mainWallet?: WalletConfig;
      configuredRole?: string;
      bundledRuntimeArchive?: string;
    },
  ) {
    this.runtime = new SoapboxSetupRuntime(path.join(options.root, "runtime"));
  }

  async status(): Promise<SoapboxSetupStatus> {
    const c = this.enrollment;
    const auth = await soapboxWalletAuthentication(this.options.mainWallet);
    return {
      configured: Boolean(this.options.configuredRole || this.activated),
      configuredRole: this.options.configuredRole ?? (this.activated ? c?.role : undefined),
      platformSupported: process.platform === "linux" && process.arch === "x64",
      bundledRuntimeAvailable: Boolean(this.options.bundledRuntimeArchive),
      hasWalletCredentials: Boolean(auth.apiKeyId && auth.apiKeySecret && auth.walletSecret),
      walletAddress: await soapboxWalletIdentity(),
      release: {
        url: SOAPBOX_SETUP_RELEASE.url,
        filename: SOAPBOX_SETUP_RELEASE.filename,
        bytes: SOAPBOX_SETUP_RELEASE.bytes,
      },
      enrollment: c && { role: c.role, id: c.id, url: c.url, address: c.address, chain_id: 84532 },
      progress: this.runtime.progress,
    };
  }

  async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Another setup action is in progress");
    if (this.options.configuredRole || this.activated)
      throw new Error("This gateway already has a Compute setup");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  async wallet(value: unknown): Promise<{ address: string }> {
    if (this.enrollment?.role === "operator")
      throw new Error("Operators do not need a buyer wallet");
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    )
      throw new Error("Invalid wallet credentials");
    try {
      return {
        address: await initializeSoapboxWallet(
          this.options.mainWallet,
          value as SoapboxWalletAuthentication | undefined,
        ),
      };
    } catch {
      throw new Error(
        "Could not initialize the test wallet. Check all three CDP credentials and internet access. Existing wallet identity must match.",
      );
    }
  }

  async import(value: unknown, role: unknown): Promise<void> {
    if (this.runtime.progress.state === "preparing")
      throw new Error("Wait for runtime preparation to finish");
    const parsed = parseSoapboxConnection(value);
    if (parsed.role !== role) throw new Error("The enrollment belongs to the other role");
    // Persist only schema fields; never accept extra configuration from the enrollment file.
    const c: SoapboxConnection = {
      version: 1,
      role: parsed.role,
      id: parsed.id,
      url: parsed.url,
      token: parsed.token,
      address: parsed.address,
      chain_id: 84532,
      escrow: parsed.escrow,
      escrow_code_sha256: parsed.escrow_code_sha256,
      rpc_url: parsed.rpc_url,
    };
    try {
      verifySoapboxConnection(c, await new SoapboxClient(c.url, c.token).status());
    } catch {
      throw new Error(
        "Enrollment verification failed. Check that the coordinator is reachable and the role, identity and Base Sepolia address match.",
      );
    }
    if (
      c.role === "buyer" &&
      (await soapboxWalletIdentity(this.options.mainWallet))?.toLowerCase() !==
        c.address.toLowerCase()
    )
      throw new Error(
        "Enrollment address must match your separate Compute test wallet. Create the wallet first, then request an enrollment for that address.",
      );
    this.enrollment = c;
  }

  requireOperator(): void {
    if (this.enrollment?.role !== "operator")
      throw new Error("Verify an operator enrollment first");
  }

  async prepareBundledRuntime(): Promise<void> {
    this.requireOperator();
    const archive = this.options.bundledRuntimeArchive;
    if (!archive || !path.isAbsolute(archive)) throw new Error("Bundled runtime unavailable");
    if ((await stat(archive)).size !== SOAPBOX_SETUP_RELEASE.bytes)
      throw new Error("Bundled runtime is damaged; reinstall the test release");
    const bytes = await readFile(archive);
    const { id } = await this.runtime.begin();
    for (let offset = 0; offset < bytes.length; offset += 262144)
      await this.runtime.chunk(
        id,
        offset,
        bytes.subarray(offset, offset + 262144).toString("base64"),
      );
    // Uses the same pinned SHA-256 and sandbox checks as a browser upload.
    await this.runtime.prepare(id);
  }

  async activate(): Promise<{ activated: true }> {
    const c = this.enrollment;
    if (!c) throw new Error("Import an enrollment first");
    verifySoapboxConnection(c, await new SoapboxClient(c.url, c.token).status());
    if (
      c.role === "buyer" &&
      (await soapboxWalletIdentity(this.options.mainWallet))?.toLowerCase() !==
        c.address.toLowerCase()
    )
      throw new Error("Buyer wallet identity changed; import enrollment again");
    if (c.role === "operator" && !this.runtime.ready)
      throw new Error("Prepare and verify the GPU runtime first");
    const original = await readFile(this.options.configPath, "utf8");
    const config = JSON5.parse(original) as BitterbotConfig;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      /"\$include"\s*:/.test(JSON.stringify(config))
    )
      throw new Error(
        "This gateway uses externally managed configuration; automatic setup is unavailable",
      );
    const existing = config.plugins?.entries?.["soapbox-compute"]?.config;
    if (
      existing &&
      (existing.mode === "participant" || existing.mode === "pilot" || existing.repository)
    )
      throw new Error("Compute was configured elsewhere; refresh before continuing");
    const directory = path.join(this.options.root, `participant-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "connection.json"), JSON.stringify(c), { mode: 0o600 });
    if (c.role === "operator")
      await copyFile(this.runtime.ready!.worker, path.join(directory, "worker.json"));
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries["soapbox-compute"] = {
      enabled: true,
      config: {
        mode: "participant",
        stateDirectory: directory,
        ...(c.role === "operator" ? { binary: this.runtime.ready!.binary } : {}),
      },
    };
    const backup = path.join(directory, "bitterbot.before.json");
    await writeFile(backup, original, { mode: 0o600 });
    const temporary = `${this.options.configPath}.soapbox-${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    if ((await readFile(this.options.configPath, "utf8")) !== original)
      throw new Error("Gateway settings changed during setup; try activation again");
    await rename(temporary, this.options.configPath);
    this.activated = true;
    return { activated: true };
  }
}
