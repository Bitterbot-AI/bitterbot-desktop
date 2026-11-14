import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { BitterbotConfig } from "../../../config/config.js";
import { resolveSandboxConfigForAgent } from "../../sandbox/config.js";

export type PackageSandboxImage = { id: string; architecture: string };
/** Read-only preflight: never let the ordinary sandbox fallback pull/install an image. */
export async function resolvePackageSandboxImage(
  config: BitterbotConfig,
  agent: string,
): Promise<PackageSandboxImage> {
  const name = resolveSandboxConfigForAgent(config, agent).docker.image;
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      ["image", "inspect", name, "--format", "{{json .}}"],
      { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const image = z
      .object({
        Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        Os: z.literal("linux"),
        Architecture: z.string().min(1).max(100),
      })
      .parse(JSON.parse(stdout));
    return { id: image.Id, architecture: image.Architecture };
  } catch {
    throw new Error(
      "Validation sandbox unavailable: prepare the configured Linux Docker image separately; evaluation will not install it",
    );
  }
}
