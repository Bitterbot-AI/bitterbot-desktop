import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import type { BitterbotConfig } from "../config/types.js";
import { SoapboxClient } from "../infra/soapbox-client.js";
import { parseSoapboxConnection, verifySoapboxConnection } from "../infra/soapbox-connection.js";
import type { SoapboxSetupProfile } from "../infra/soapbox-setup-types.js";
import { readLocalOperator } from "./soapbox-local-operator.js";

type Entry = NonNullable<NonNullable<BitterbotConfig["plugins"]>["entries"]>[string];
type Profile = { id: string; entry: Entry };
const activeStatuses = new Set([
  "queued",
  "running",
  "awaiting_payment",
  "settlement_pending",
  "refund_pending",
  "payment_review",
]);

/** Only profiles created locally are selectable; the UI never supplies paths or credentials. */
export class SoapboxProfiles {
  constructor(
    private root: string,
    private configPath: string,
  ) {}

  async config() {
    const original = await readFile(this.configPath, "utf8");
    const config = JSON5.parse(original) as BitterbotConfig;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      /"\$include"\s*:/.test(JSON.stringify(config))
    )
      throw new Error("Externally managed configuration cannot be changed automatically");
    return { original, config, entry: config.plugins?.entries?.["soapbox-compute"] };
  }

  private profile(entry?: Entry): Profile | undefined {
    const c = entry?.config;
    if (!c || (c.mode !== "participant" && c.mode !== "mesh-operator")) return;
    if (typeof c.stateDirectory !== "string" || !path.isAbsolute(c.stateDirectory))
      throw new Error("Invalid saved Compute profile");
    // Preserve only Compute's schema fields. Never snapshot the main wallet in the registry.
    const clean: Entry = {
      enabled: true,
      config: {
        mode: c.mode,
        stateDirectory: c.stateDirectory,
        ...(typeof c.binary === "string" ? { binary: c.binary } : {}),
        ...(typeof c.bundledRuntimeArchive === "string"
          ? { bundledRuntimeArchive: c.bundledRuntimeArchive }
          : {}),
      },
    };
    return {
      id: createHash("sha256").update(`${c.mode}:${c.stateDirectory}`).digest("hex").slice(0, 24),
      entry: clean,
    };
  }

  private async saved(): Promise<Profile[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.root, "profiles.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 32)
      throw new Error("Invalid Compute profile registry");
    return value.map((p: Profile) => {
      const checked = this.profile(p.entry);
      if (!checked || checked.id !== p.id) throw new Error("Invalid Compute profile registry");
      return checked;
    });
  }

  private async describe(p: Profile, current?: string): Promise<SoapboxSetupProfile> {
    const c = p.entry.config!;
    if (c.mode === "mesh-operator")
      return {
        id: p.id,
        role: "mesh-operator",
        name: "Local P2P operator",
        active: p.id === current,
      };
    const connection = parseSoapboxConnection(
      JSON.parse(await readFile(path.join(String(c.stateDirectory), "connection.json"), "utf8")),
    );
    return {
      id: p.id,
      role: connection.role,
      name: `${connection.role === "buyer" ? "Buyer" : "Paid operator"} · ${connection.id}`,
      active: p.id === current,
    };
  }

  async list(): Promise<SoapboxSetupProfile[]> {
    let current: Profile | undefined;
    try {
      current = this.profile((await this.config()).entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const entries = new Map((await this.saved()).map((p) => [p.id, p]));
    if (current) entries.set(current.id, current);
    return Promise.all([...entries.values()].map((p) => this.describe(p, current?.id)));
  }

  async find(id: unknown): Promise<Entry> {
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id))
      throw new Error("Invalid Compute profile ID");
    const p = (await this.saved()).find((p) => p.id === id);
    if (!p) throw new Error("Saved Compute profile not found");
    return p.entry;
  }

  async client(entry?: Entry): Promise<SoapboxClient | undefined> {
    if (!this.profile(entry)) return;
    const c = entry!.config!;
    if (c.mode === "mesh-operator") {
      const local = await readLocalOperator(String(c.stateDirectory));
      return new SoapboxClient(local.url, local.admin);
    }
    const connection = parseSoapboxConnection(
      JSON.parse(await readFile(path.join(String(c.stateDirectory), "connection.json"), "utf8")),
    );
    return new SoapboxClient(connection.url, connection.token);
  }

  async requireIdle(entry?: Entry): Promise<void> {
    const client = await this.client(entry);
    if (!client) return;
    // Fail closed if the current coordinator is offline: work/payment state is unknown.
    const status = await client.status();
    if (!Number.isSafeInteger(status.active_jobs) || status.active_jobs! < 0)
      throw new Error(
        "Update this coordinator to Soapbox rc10 or newer before switching profiles; the complete active-job count is unavailable",
      );
    if (status.active_jobs !== 0 || status.jobs?.some((job) => activeStatuses.has(job.status)))
      throw new Error(
        "Finish or cancel active jobs and resolve pending payments before switching profiles",
      );
    if (
      (entry?.config?.mode === "mesh-operator" || status.principal?.roles.includes("worker")) &&
      status.nodes?.some(
        (node) =>
          node.online &&
          !node.operator_paused &&
          (entry?.config?.mode === "mesh-operator" || node.id === status.principal?.id),
      )
    )
      throw new Error("Pause new work on your operator before switching profiles");
  }

  async verify(entry: Entry, wallet: string | null): Promise<void> {
    const c = entry.config!;
    if (c.mode === "participant") {
      const connection = parseSoapboxConnection(
        JSON.parse(await readFile(path.join(String(c.stateDirectory), "connection.json"), "utf8")),
      );
      verifySoapboxConnection(connection, await (await this.client(entry))!.status());
      if (connection.role === "buyer" && wallet?.toLowerCase() !== connection.address.toLowerCase())
        throw new Error("Saved buyer profile does not match the separate Compute wallet");
      if (connection.role === "buyer") return;
    } else await readLocalOperator(String(c.stateDirectory));
    const worker = JSON.parse(
      await readFile(path.join(String(c.stateDirectory), "worker.json"), "utf8"),
    );
    if (
      !worker.sandbox ||
      worker.allow_unsafe_host ||
      typeof c.binary !== "string" ||
      !path.isAbsolute(c.binary)
    )
      throw new Error("Saved operator requires an isolated runtime");
    await access(c.binary, constants.X_OK);
  }

  async saveAndWrite(original: string, config: BitterbotConfig): Promise<void> {
    const prior = JSON5.parse(original) as BitterbotConfig;
    const profiles = new Map((await this.saved()).map((p) => [p.id, p]));
    for (const entry of [
      prior.plugins?.entries?.["soapbox-compute"],
      config.plugins?.entries?.["soapbox-compute"],
    ]) {
      const p = this.profile(entry);
      if (p) profiles.set(p.id, p);
    }
    if (profiles.size > 32) throw new Error("Compute profile limit reached");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const writeAtomic = async (file: string, data: string) => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, file);
    };
    if ((await readFile(this.configPath, "utf8")) !== original)
      throw new Error("Gateway settings changed; refresh before switching");
    await writeAtomic(
      path.join(this.root, "profiles.json"),
      JSON.stringify([...profiles.values()]),
    );
    await writeAtomic(path.join(this.root, "profile-switch.before.json"), original);
    if ((await readFile(this.configPath, "utf8")) !== original)
      throw new Error("Gateway settings changed; refresh before switching");
    await writeAtomic(this.configPath, JSON.stringify(config, null, 2) + "\n");
  }
}
