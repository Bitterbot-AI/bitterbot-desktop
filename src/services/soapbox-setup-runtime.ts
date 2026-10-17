import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SoapboxSetupStatus } from "../infra/soapbox-setup-types.js";
import { soapboxOperatorEnvironment } from "../infra/soapbox-connection.js";

export const SOAPBOX_SETUP_RELEASE = {
  url: "https://github.com/Bitterbot-AI/soapbox/releases/tag/v0.3.0-rc.1",
  filename: "soapbox-0.3.0-rc.1-linux-x64.tar.gz",
  bytes: 15824317,
  sha256: "03c4c2de8e42032c6710ce0b4f1170d893c2a36b26a0ad88398173cd16ff9588",
};

/** Fresh operator profiles do not have the wallet-created shared runtime directory. */
export async function prepareSoapboxGpuLock(home = homedir()): Promise<string> {
  const directory = path.join(home, ".bitterbot-soapbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, "gpu.lock");
}

/** Fixed executables/arguments only. Never forward child output or gateway credentials to the UI. */
export function runSetupCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 180000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: soapboxOperatorEnvironment("", process.env),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-262144);
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Setup command unavailable or interrupted"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !signal?.aborted) resolve(output.trim());
      else reject(new Error("Setup command failed or timed out"));
    });
  });
}

export class SoapboxSetupRuntime {
  progress: SoapboxSetupStatus["progress"] = {
    state: "idle",
    message: "Import an enrollment to begin.",
    percent: 0,
  };
  ready?: { binary: string; worker: string };
  private upload?: { id: string; directory: string; offset: number; expires: number };
  private controller?: AbortController;
  private task?: Promise<void>;
  constructor(
    private root: string,
    private run = runSetupCommand,
  ) {}

  async begin(): Promise<{ id: string; offset: number }> {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error("GPU operators require an Ubuntu x64 gateway (WSL2 supported)");
    if (this.progress.state === "preparing")
      throw new Error("Runtime preparation is already running");
    if (this.upload) await rm(this.upload.directory, { recursive: true, force: true });
    const id = randomUUID(),
      directory = path.join(this.root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const space = await statfs(directory);
    if (space.bavail * space.bsize < 3 * 1024 ** 3)
      throw new Error("At least 3 GB of free disk space is required");
    this.ready = undefined;
    this.upload = { id, directory, offset: 0, expires: Date.now() + 600000 };
    this.progress = { state: "uploading", message: "Receiving approved runtime", percent: 0 };
    return { id, offset: 0 };
  }

  async chunk(id: unknown, offset: unknown, data: unknown): Promise<{ offset: number }> {
    const upload = this.upload;
    if (
      !upload ||
      upload.id !== id ||
      this.progress.state !== "uploading" ||
      upload.expires < Date.now()
    )
      throw new Error("Runtime upload expired; select the file again");
    if (
      offset !== upload.offset ||
      typeof data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
      data.length > 349528
    )
      throw new Error("Invalid runtime chunk");
    const bytes = Buffer.from(data, "base64");
    if (
      !bytes.length ||
      bytes.length > 262144 ||
      bytes.toString("base64") !== data ||
      upload.offset + bytes.length > SOAPBOX_SETUP_RELEASE.bytes
    )
      throw new Error("Invalid runtime size");
    await appendFile(path.join(upload.directory, "runtime.tar.gz"), bytes, { mode: 0o600 });
    upload.offset += bytes.length;
    this.progress.percent = Math.floor((upload.offset / SOAPBOX_SETUP_RELEASE.bytes) * 100);
    return { offset: upload.offset };
  }

  async prepare(id: unknown): Promise<void> {
    const upload = this.upload;
    if (
      !upload ||
      upload.id !== id ||
      upload.offset !== SOAPBOX_SETUP_RELEASE.bytes ||
      this.progress.state !== "uploading"
    )
      throw new Error("Complete the runtime upload first");
    const archive = path.join(upload.directory, "runtime.tar.gz");
    if (
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex") !== SOAPBOX_SETUP_RELEASE.sha256
    ) {
      this.progress = {
        state: "failed",
        message: "Runtime checksum did not match the approved release. Download it again.",
        percent: 0,
      };
      await rm(upload.directory, { recursive: true, force: true });
      throw new Error(this.progress.message);
    }
    this.controller = new AbortController();
    this.progress = { state: "preparing", message: "Checking Docker and NVIDIA GPU", percent: 5 };
    this.task = this.build(upload.directory, this.controller.signal).catch(() => {
      this.progress = {
        ...this.progress,
        state: "failed",
        message: `${this.progress.message} failed. Check Docker, NVIDIA drivers and internet access, then retry.`,
      };
    });
  }

  private async build(directory: string, signal: AbortSignal): Promise<void> {
    const run = (cmd: string, args: string[], timeout?: number) =>
      this.run(cmd, args, signal, timeout);
    if ((await run("docker", ["info", "--format", "{{.SwapLimit}}"], 30000)) !== "true")
      throw new Error("Docker must enforce swap limits");
    await run(
      existsSync("/usr/lib/wsl/lib/nvidia-smi") ? "/usr/lib/wsl/lib/nvidia-smi" : "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      30000,
    );
    await run("tar", ["-xzf", path.join(directory, "runtime.tar.gz"), "-C", directory]);
    const released = path.join(directory, "soapbox-0.3.0-rc.1-linux-x64");
    const build = path.join(directory, "image"),
      models = path.join(directory, "models");
    if (/[\n,]/.test(models)) throw new Error("Unsupported runtime directory");
    await mkdir(build);
    await mkdir(models);
    const binary = path.join(released, "bin/soapbox");
    await chmod(binary, 0o700);
    await copyFile(binary, path.join(build, "soapbox"));
    await copyFile(path.join(released, "containers/Dockerfile"), path.join(build, "Dockerfile"));
    this.progress = {
      state: "preparing",
      message: "Building the isolated GPU runtime",
      percent: 25,
    };
    const tag = `soapbox-setup:${path.basename(directory)}`;
    await run(
      "docker",
      ["buildx", "build", "--builder", "default", "--load", "--tag", tag, build],
      900000,
    );
    const image = await run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid runtime image");
    this.progress = {
      state: "preparing",
      message: "Downloading the approved embedding model",
      percent: 55,
    };
    const name = `soapbox-setup-${path.basename(directory)}`;
    try {
      await run("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--memory=2g",
        "--memory-swap=2g",
        "--pids-limit=128",
        "--env",
        "OLLAMA_MODELS=/models",
        "--env",
        "OLLAMA_NO_CLOUD=1",
        "--mount",
        `type=bind,source=${models},target=/models`,
        "--entrypoint=/bin/ollama",
        image,
        "serve",
      ]);
      let ready = false;
      for (let i = 0; i < 30 && !signal.aborted; i++) {
        try {
          await run("docker", ["exec", name, "/bin/ollama", "list"], 5000);
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!ready) throw new Error("Model runtime did not start");
      await run("docker", ["exec", name, "/bin/ollama", "pull", "all-minilm:latest"], 600000);
    } finally {
      await this.run("docker", ["rm", "-f", name], undefined, 30000).catch(() => {});
    }
    this.progress = {
      state: "preparing",
      message: "Verifying GPU execution and isolation",
      percent: 85,
    };
    const worker = path.join(directory, "worker.json");
    await writeFile(
      worker,
      JSON.stringify({
        modes: ["paid"],
        pools: [],
        projects: [],
        memory_mib: 1024,
        ollama_model: "all-minilm:latest",
        ollama_digest: "1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef",
        max_gpu_temperature_c: 80,
        max_gpu_utilization_pct: 40,
        min_gpu_free_mib: 256,
        pause_file: path.join(directory, "PAUSE"),
        min_price_credits: 1,
        allow_unsafe_host: false,
        sandbox: { image, models, gpu_lock: await prepareSoapboxGpuLock() },
      }),
      { mode: 0o600 },
    );
    const probe = JSON.parse(await run(binary, ["inspect", "--config", worker]));
    if (!probe.gpu_observed || probe.isolation !== "docker_v1")
      throw new Error("GPU runtime is not ready");
    this.ready = { binary, worker };
    this.progress = {
      state: "ready",
      message: "GPU runtime verified. Review your enrollment and activate.",
      percent: 100,
    };
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.task;
  }
}
