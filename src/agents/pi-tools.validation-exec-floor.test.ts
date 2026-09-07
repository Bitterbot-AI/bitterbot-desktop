/**
 * PLAN-45 5.5 (adversarial): a skill-validation shell must enforce the
 * allowlist + safeBins floor no matter which exec host the operator
 * configured for the main agent. The floor is only evaluated on the
 * gateway/node hosts; the default host is "sandbox", which ran the command
 * raw when no sandbox was configured (python3/node/curl all executed inside
 * validation trials before this pin). Real execution, not a name check.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createBitterbotCodingTools } from "./pi-tools.js";

describe("validation exec floor (PLAN-45 5.5)", () => {
  it("a validation shell enforces the safeBins floor whatever host the operator configured (PLAN-45 5.5 adversarial)", async () => {
    // The floor is evaluated on the gateway host only; the default host is
    // "sandbox", which ran commands raw when no sandbox was configured.
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "val-exec-floor-"));
    try {
      for (const host of [undefined, "sandbox", "node"] as const) {
        const tools = createBitterbotCodingTools({
          sessionKey: "agent:main:skill-evolve-val-deadbeef",
          workspaceDir: ws,
          ...(host ? { exec: { host } } : {}),
        });
        const exec = tools.find((t) => t.name === "exec");
        expect(exec).toBeDefined();
        const run = (command: string) =>
          exec!.execute("call", { command, timeout: 10 } as never) as Promise<{
            details?: { exitCode?: number; aggregated?: string };
          }>;
        for (const denied of [
          'python3 -c "print(1)"',
          "node -e 1",
          "curl -s https://example.com",
          "cat /etc/hostname",
        ]) {
          await expect(run(denied)).rejects.toThrow(/exec denied: allowlist miss/);
        }
        const ok = await run("echo floor-ok");
        expect(ok.details?.exitCode).toBe(0);
        expect(ok.details?.aggregated).toContain("floor-ok");
      }
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
