import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

/** Operator-owned runtime check, before any package evaluation or paid model request.
 * No host files, credentials or network are exposed to the disposable probe container. */
export async function probeStudyImage(image: string): Promise<{ python: string; image: string }> {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Probe requires a pinned installed image");
  const container = `bb-study-probe-${randomUUID()}`;
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        container,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--pids-limit",
        "32",
        "--memory",
        "128m",
        "--cpus",
        "1",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=16m",
        image,
        "sh",
        "-c",
        "command -v sleep >/dev/null && python3 -c 'import datetime,json,platform; print(json.dumps({\"python\":platform.python_version()}))'",
      ],
      { timeout: 60000, maxBuffer: 8192, windowsHide: true },
    );
    const result = z
      .object({ python: z.string().regex(/^3\./) })
      .strict()
      .parse(JSON.parse(stdout));
    return { ...result, image };
  } catch {
    throw new Error(
      "Study sandbox preflight failed: the installed image must support the ordinary shell/sleep entry point and Python 3; no model call was made",
    );
  } finally {
    await promisify(execFile)("docker", ["rm", "-f", container], {
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
    }).catch(() => {});
  }
}
