import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SoapboxClient } from "../infra/soapbox-client.js";
import { soapboxOperatorEnvironment } from "../infra/soapbox-connection.js";

export type LocalOperator = {
  version: 1;
  chain_id: 84532;
  url: string;
  admin: string;
  worker: string;
};

export async function readLocalOperator(directory: string): Promise<LocalOperator> {
  const value = JSON.parse(await readFile(path.join(directory, "mesh-operator.json"), "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.chain_id !== 84532 ||
    typeof value.url !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(value.url) ||
    !Number(new URL(value.url).port) ||
    typeof value.admin !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.admin) ||
    typeof value.worker !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.worker) ||
    value.admin === value.worker
  )
    throw new Error("Invalid local Compute operator configuration");
  return value as LocalOperator;
}

export async function prepareLocalOperator(
  directory: string,
  runtime: { binary: string; worker: string },
): Promise<LocalOperator> {
  const template = JSON.parse(await readFile(runtime.worker, "utf8"));
  if (!template.sandbox || template.allow_unsafe_host || !path.isAbsolute(runtime.binary))
    throw new Error("Verified isolated runtime required");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
  const settings: LocalOperator = {
    version: 1,
    chain_id: 84532,
    url: `http://127.0.0.1:${port}`,
    admin: randomBytes(32).toString("hex"),
    worker: randomBytes(32).toString("hex"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) =>
    writeFile(path.join(directory, name), JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await save("mesh-operator.json", settings);
  // No settlement credentials or paid mode are created for a private/collective pool.
  await save("coordinator.json", {
    principals: [
      {
        id: "local-admin",
        token_env: "SOAPBOX_LOCAL_ADMIN",
        roles: ["admin", "submitter"],
        pools: ["private"],
        projects: ["community"],
      },
      {
        id: "local-worker",
        token_env: "SOAPBOX_WORKER_TOKEN",
        roles: ["worker"],
        pools: ["private"],
        projects: ["community"],
      },
    ],
    collective_daily_items: 1000,
    artifact_quota_bytes: 16 * 1024 * 1024,
  });
  await save("worker.json", {
    ...template,
    modes: ["private", "collective"],
    pools: ["private"],
    projects: ["community"],
    memory_mib: 2048,
    pause_file: path.join(directory, "PAUSE"),
  });
  return settings;
}

/** Own only these child processes; restart the pair together if either exits. */
export class LocalOperatorService {
  private children: ChildProcess[] = [];
  private stopped = true;
  private restarting = false;
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  constructor(
    private directory: string,
    private binary: string,
    private log: (message: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return this.task;
    this.stopped = false;
    this.task = this.launch();
    try {
      await this.task;
    } catch (error) {
      await this.stopChildren();
      this.scheduleRestart(10000);
      throw error;
    }
  }

  private async launch(): Promise<void> {
    const settings = await readLocalOperator(this.directory);
    if (this.stopped) return;
    const spawnOne = (args: string[], env: NodeJS.ProcessEnv) => {
      const fd = openSync(path.join(this.directory, "operator.log"), "a", 0o600);
      let child: ChildProcess;
      try {
        child = spawn(this.binary, args, { env, stdio: ["ignore", fd, fd], windowsHide: true });
      } finally {
        closeSync(fd);
      }
      this.children.push(child);
      child.on("error", () => this.log("Compute process could not start; check operator.log"));
      return child;
    };
    const env = soapboxOperatorEnvironment(settings.worker, process.env);
    const coordinator = spawnOne(
      [
        "serve",
        "--config",
        path.join(this.directory, "coordinator.json"),
        "--db",
        path.join(this.directory, "runtime.db"),
        "--bind",
        new URL(settings.url).host,
      ],
      { ...env, SOAPBOX_LOCAL_ADMIN: settings.admin },
    );
    const client = new SoapboxClient(settings.url, settings.admin);
    let ready = false;
    for (let i = 0; i < 60 && !this.stopped; i++) {
      if (coordinator.exitCode !== null || coordinator.signalCode !== null) break;
      const status = await client.status(500).catch(() => null);
      if (status?.principal?.id === "local-admin" && status.capabilities?.mesh_admissions) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error("Local Compute coordinator failed to start");
    if (this.stopped) return;
    const worker = spawnOne(
      [
        "worker",
        "--config",
        path.join(this.directory, "worker.json"),
        "--coordinator",
        settings.url,
      ],
      env,
    );
    for (const child of [coordinator, worker]) child.once("exit", () => this.scheduleRestart());
  }

  private scheduleRestart(wait = 5000): void {
    if (this.stopped || this.timer || this.restarting) return;
    this.log("Compute process stopped; restarting the local operator");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.restarting = true;
      let retry = false;
      this.task = this.stopChildren()
        .then(() => (this.stopped ? undefined : this.launch()))
        .catch(() => {
          retry = true;
        })
        .finally(() => {
          this.restarting = false;
          if (retry) this.scheduleRestart(10000);
        });
    }, wait);
  }

  async waitForGpu(): Promise<void> {
    const settings = await readLocalOperator(this.directory);
    const client = new SoapboxClient(settings.url, settings.admin);
    for (let i = 0; i < 180 && !this.stopped; i++) {
      const status = await client.status(1000).catch(() => null);
      if (
        status?.nodes?.some(
          (n) =>
            n.online &&
            !n.operator_paused &&
            !n.offer.paused &&
            n.offer.gpu_observed &&
            n.offer.isolation === "docker_v1",
        )
      )
        return;
      await delay(1000);
    }
    throw new Error("GPU operator did not become ready; free the GPU and retry setup");
  }

  private async stopChildren(): Promise<void> {
    const children = this.children.splice(0);
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.stopChildren();
    await this.task?.catch(() => {});
    await this.stopChildren();
  }
}
