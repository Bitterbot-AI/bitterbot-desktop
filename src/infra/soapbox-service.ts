import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { soapboxClientFromEnv } from "./soapbox-client.js";

const log = createSubsystemLogger("soapbox");

/** Optional process ownership. Existing/external coordinators are never stopped. */
export async function startSoapboxService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }),
    );
  };
  if (env.BITTERBOT_SOAPBOX_ENABLED !== "1") return stop;
  try {
    const client = soapboxClientFromEnv(env);
    const binary = env.BITTERBOT_SOAPBOX_BINARY;
    const launch = (args: string[]) => {
      if (!binary || !isAbsolute(binary))
        throw new Error("BITTERBOT_SOAPBOX_BINARY must be an absolute path");
      const childEnv = Object.fromEntries(
        Object.entries(env).filter(
          ([key]) =>
            !/(PRIVATE_KEY|SECRET|MNEMONIC)/i.test(key) &&
            (/^(SOAPBOX_|BITTERBOT_SOAPBOX_)/.test(key) ||
              /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|LD_LIBRARY_PATH|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
                key,
              )),
        ),
      );
      const child = spawn(binary, args, {
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      children.push(child);
      child.on("error", (error) => log.warn(`Soapbox process could not start: ${error.message}`));
      child.on("exit", (code) => {
        if (code) log.warn(`Soapbox process exited with code ${code}`);
      });
    };
    if (env.BITTERBOT_SOAPBOX_CONFIG) {
      if (!env.BITTERBOT_SOAPBOX_DB)
        throw new Error("BITTERBOT_SOAPBOX_DB is required for a managed coordinator");
      const url = new URL(env.BITTERBOT_SOAPBOX_URL ?? "http://127.0.0.1:8787");
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error("Managed Soapbox coordinator must use http://127.0.0.1");
      }
      launch([
        "serve",
        "--config",
        env.BITTERBOT_SOAPBOX_CONFIG,
        "--db",
        env.BITTERBOT_SOAPBOX_DB,
        "--bind",
        `127.0.0.1:${url.port || "80"}`,
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (children[0]?.exitCode !== null && children[0]?.exitCode !== undefined) break;
        try {
          await client?.status(500);
          ready = true;
          break;
        } catch {
          /* startup may still be binding */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error("Soapbox coordinator did not become ready");
    }
    // A worker is an explicit, separate opt-in to contribute this machine's resources.
    if (env.BITTERBOT_SOAPBOX_WORKER_CONFIG) {
      launch([
        "worker",
        "--config",
        env.BITTERBOT_SOAPBOX_WORKER_CONFIG,
        "--coordinator",
        env.BITTERBOT_SOAPBOX_URL ?? "http://127.0.0.1:8787",
      ]);
    }
  } catch (error) {
    await stop();
    log.warn(`Soapbox integration unavailable: ${String(error)}`);
  }
  return stop;
}
