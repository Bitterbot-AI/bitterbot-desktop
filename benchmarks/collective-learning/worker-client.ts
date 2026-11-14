import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StudyLedger } from "./study-ledger.js";
import type { NodeDescriptor } from "./study-node.js";
import type { PairedObservation } from "./study.js";

export class WorkerClient {
  readonly child: ChildProcess;
  readonly ready: Promise<NodeDescriptor>;
  private requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(
    directory: string,
    spec: string,
    condition: string,
    node: string,
    readonly ledger: StudyLedger,
    readonly progress: (message: string) => void = () => {},
  ) {
    const log = fs.openSync(path.join(directory, "worker.log"), "a", 0o600);
    const launchOptions: ForkOptions & { windowsHide: boolean } = {
      execArgv: ["--import", "tsx"],
      windowsHide: true,
      env: {
        ...process.env,
        BITTERBOT_STATE_DIR: directory,
        BITTERBOT_CONFIG_PATH: path.join(directory, "bitterbot.json"),
        BITTERBOT_DISABLE_DISCOVERY: "1",
      },
      stdio: ["ignore", log, log, "ipc"],
    };
    this.child = fork(
      fileURLToPath(new URL("./node-worker.ts", import.meta.url)),
      [directory, spec, condition, node],
      launchOptions,
    );
    fs.closeSync(log);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker ${condition}/${node} startup timed out; inspect its log`)),
        600000,
      );
      this.child.on("message", (raw: unknown) => {
        const message = raw as {
          type: string;
          id: string;
          error?: string;
          descriptor: NodeDescriptor;
          operation: string;
          value: unknown;
          result: unknown;
        };
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(message.descriptor);
        } else if (message.type === "failed") {
          clearTimeout(timer);
          reject(new Error(message.error));
        } else if (message.type === "accounting") {
          try {
            if (message.operation === "reserve") this.ledger.reserve(message.value);
            else if (message.operation === "finish") {
              const value = message.value as {
                id: string;
                row: PairedObservation;
                artifact: unknown;
              };
              this.ledger.finish(value.id, value.row, value.artifact);
              this.progress(
                `${condition}/${node}: ${value.row.phase} ${value.row.taskId} ${value.row.success === null ? "unresolved" : value.row.success ? "pass" : "fail"}`,
              );
            } else throw new Error("Unknown accounting operation");
            this.child.send({ type: "accounted", id: message.id });
          } catch (error) {
            this.child.send({ type: "accounted", id: message.id, error: String(error) });
          }
        } else if (message.type === "response") {
          const request = this.requests.get(message.id);
          this.requests.delete(message.id);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve(message.result);
        }
      });
      this.child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      this.child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const error = new Error(
          `Worker ${condition}/${node} exited (${code ?? signal}); unresolved costs and commands are retained`,
        );
        reject(error);
        for (const request of this.requests.values()) request.reject(error);
        this.requests.clear();
      });
    });
  }
  async call(
    method: string,
    input: Record<string, unknown> = {},
    id: string = randomUUID(),
  ): Promise<unknown> {
    await this.ready;
    if (!this.child.connected) throw new Error("Study worker disconnected");
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.child.send({ type: "request", id, method, input });
    });
  }
  async close(): Promise<void> {
    if (!this.child.connected) return;
    await this.call("close").catch(() => {
      this.child.kill();
    });
  }
}
