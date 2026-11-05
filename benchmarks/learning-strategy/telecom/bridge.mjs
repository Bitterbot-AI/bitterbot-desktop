import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export function createBridge() {
  const python =
    process.env.TAU_PYTHON ??
    path.join(here, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)),
  );
  const child = spawn(python, ["-X", "utf8", "-B", path.join(here, "native.py")], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let pending,
    closed = false,
    stderr = "";
  const reject = (error) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    try {
      const row = JSON.parse(line);
      if (!row.ok) throw Error(row.error);
      current.resolve(row.result);
    } catch (error) {
      current.reject(error);
    }
  });
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    closed = true;
    reject(Error(`Native bridge exited (${code}): ${stderr}`));
  });
  return {
    request(value) {
      if (closed || pending) return Promise.reject(Error("Native bridge unavailable or busy"));
      return new Promise((resolve, fail) => {
        const timer = setTimeout(() => {
          reject(Error("Native bridge timeout"));
          child.kill();
        }, 30000);
        pending = { resolve, reject: fail, timer };
        child.stdin.write(JSON.stringify(value) + "\n", (error) => {
          if (error) reject(error);
        });
      });
    },
    close() {
      closed = true;
      reject(Error("Native bridge closed"));
      child.stdin.end();
      child.kill();
    },
  };
}
