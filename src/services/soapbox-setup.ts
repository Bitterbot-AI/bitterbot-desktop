import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import type { BitterbotConfig } from "../config/types.js";
import type { WalletConfig } from "../config/types.wallet.js";
import { SoapboxClient } from "../infra/soapbox-client.js";
import {
  parseSoapboxConnection,
  verifySoapboxConnection,
  type SoapboxConnection,
} from "../infra/soapbox-connection.js";
import type { SoapboxSetupStatus } from "../infra/soapbox-setup-types.js";
import { beginSoapboxTransition } from "../infra/soapbox-transition.js";
import { LocalOperatorService, prepareLocalOperator } from "./soapbox-local-operator.js";
import { SoapboxProfiles } from "./soapbox-profiles.js";
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
  private localSetup?: Promise<void>;
  private localRunning = false;
  private stopping = false;
  private localService?: LocalOperatorService;
  private profiles: SoapboxProfiles;
  private draftEntry?: string;
  private releaseTransition?: () => void;
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
    this.profiles = new SoapboxProfiles(options.root, options.configPath);
  }

  async status(): Promise<SoapboxSetupStatus> {
    const c = this.enrollment;
    const auth = await soapboxWalletAuthentication(this.options.mainWallet);
    return {
      configured: Boolean(this.options.configuredRole || this.activated),
      configuredRole:
        this.options.configuredRole ?? (this.activated ? (c?.role ?? "mesh-operator") : undefined),
      profiles: await this.profiles.list(),
      addingProfile: this.draftEntry !== undefined,
      canManageProfiles: ["participant", "mesh-operator"].includes(
        this.options.configuredRole ?? "",
      ),
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

  async mutate<T>(action: () => Promise<T>, profileAction = false): Promise<T> {
    if (this.busy || this.localRunning) throw new Error("Another setup action is in progress");
    if (profileAction && this.runtime.progress.state === "preparing")
      throw new Error("Wait for runtime preparation to finish");
    if (
      (this.options.configuredRole || this.activated) &&
      !profileAction &&
      this.draftEntry === undefined
    )
      throw new Error("This gateway already has a Compute setup");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  async newProfile(): Promise<void> {
    if (!["participant", "mesh-operator"].includes(this.options.configuredRole ?? ""))
      throw new Error("This setup cannot manage saved profiles");
    if (this.releaseTransition) throw new Error("Wait for the gateway to reconnect");
    this.draftEntry = JSON.stringify((await this.profiles.config()).entry);
    this.enrollment = undefined;
    this.runtime.ready = undefined;
    this.runtime.progress = {
      state: "idle",
      percent: 0,
      message: "Prepare another profile. The current profile stays active until you activate.",
    };
  }

  async cancelProfile(): Promise<void> {
    if (this.runtime.progress.state === "preparing")
      throw new Error("Wait for runtime preparation to finish");
    this.draftEntry = undefined;
    this.enrollment = undefined;
  }

  async switchProfile(id: unknown): Promise<{ activated: true }> {
    if (!["participant", "mesh-operator"].includes(this.options.configuredRole ?? ""))
      throw new Error("This setup cannot switch profiles");
    const next = await this.profiles.find(id);
    await this.profiles.verify(next, await soapboxWalletIdentity(this.options.mainWallet));
    const { original, config } = await this.profiles.config();
    config.plugins!.entries!["soapbox-compute"] = next;
    await this.commitProfile(original, config);
    return { activated: true };
  }

  private async commitProfile(original: string, config: BitterbotConfig): Promise<void> {
    const prior = JSON5.parse(original) as BitterbotConfig;
    const entry = prior.plugins?.entries?.["soapbox-compute"];
    if (this.draftEntry !== undefined && JSON.stringify(entry) !== this.draftEntry)
      throw new Error("Compute profile changed during setup; reopen setup before activating");
    const release = beginSoapboxTransition();
    this.releaseTransition = release;
    try {
      await this.profiles.requireIdle(entry);
      if (this.stopping) throw new Error("Gateway is stopping; retry setup after reconnecting");
      await this.profiles.saveAndWrite(original, config);
      this.activated = true;
    } catch (error) {
      release();
      this.releaseTransition = undefined;
      throw error;
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
    await this.prepareArchive();
  }

  private async prepareArchive(): Promise<void> {
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

  async enableLocalOperator(): Promise<void> {
    if (this.enrollment)
      throw new Error("Clear enrollment by reopening setup before choosing a local pool");
    if (!this.options.bundledRuntimeArchive)
      throw new Error("Install the matching Compute release first");
    this.localRunning = true;
    this.runtime.progress = {
      state: "uploading",
      message: "Checking the included runtime",
      percent: 0,
    };
    this.localSetup = this.finishLocalOperator()
      .catch((error: unknown) => {
        this.runtime.progress = {
          state: "failed",
          percent: 0,
          message: error instanceof Error ? error.message : "Operator setup failed; retry",
        };
      })
      .finally(() => {
        this.localRunning = false;
      });
  }

  private async finishLocalOperator(): Promise<void> {
    await this.prepareArchive();
    await this.runtime.waitUntilReady();
    if (this.stopping) return;
    const original = await readFile(this.options.configPath, "utf8");
    const config = JSON5.parse(original) as BitterbotConfig;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      /"\$include"\s*:/.test(JSON.stringify(config))
    )
      throw new Error("Externally managed configuration cannot be changed automatically");
    const existing = config.plugins?.entries?.["soapbox-compute"]?.config;
    if (existing && existing.mode !== "setup" && this.draftEntry === undefined)
      throw new Error("Compute was configured elsewhere; refresh before continuing");
    const directory = path.join(this.options.root, `operator-${randomUUID()}`);
    await prepareLocalOperator(directory, this.runtime.ready!);
    const service = new LocalOperatorService(directory, this.runtime.ready!.binary);
    this.localService = service;
    this.runtime.progress = {
      state: "preparing",
      message: "Verifying your local P2P operator",
      percent: 95,
    };
    try {
      await service.start();
      await service.waitForGpu();
    } finally {
      await service.stop();
      this.localService = undefined;
    }
    if (this.stopping) return;
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries["soapbox-compute"] = {
      enabled: true,
      config: {
        mode: "mesh-operator",
        stateDirectory: directory,
        binary: this.runtime.ready!.binary,
        bundledRuntimeArchive: this.options.bundledRuntimeArchive,
      },
    };
    config.p2p = { ...config.p2p, enabled: true };
    await writeFile(path.join(directory, "bitterbot.before.json"), original, { mode: 0o600 });
    await this.commitProfile(original, config);
    this.runtime.progress = {
      state: "ready",
      message: "Operator enabled. Reconnecting to the gateway…",
      percent: 100,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.runtime.stop();
    await this.localService?.stop();
    await this.localSetup;
    this.releaseTransition?.();
  }

  async waitForLocalSetup(): Promise<void> {
    await this.localSetup;
    if (!this.activated) throw new Error(this.runtime.progress.message);
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
      this.draftEntry === undefined &&
      (existing.mode === "participant" ||
        existing.mode === "pilot" ||
        existing.mode === "mesh-operator" ||
        existing.repository)
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
    await this.commitProfile(original, config);
    return { activated: true };
  }
}
