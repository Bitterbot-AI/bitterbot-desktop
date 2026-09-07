/**
 * Sandboxing is opt-in: with tools.exec.host at its "sandbox" default and no
 * sandbox configured, exec runs on the gateway machine with no allowlist
 * evaluation (documented in docs/gateway/security). An EXPLICIT
 * security=deny, configured or requested, must still deny on that path;
 * the unset default keeps its documented behavior.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createBitterbotCodingTools } from "./pi-tools.js";

let ws: string;
beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "exec-sandbox-deny-"));
});
afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

type ExecResult = { details?: { exitCode?: number; aggregated?: string } };

function execTool(exec?: { security?: "deny" | "allowlist" | "full" }) {
  const tools = createBitterbotCodingTools({
    sessionKey: "agent:main:main",
    workspaceDir: ws,
    ...(exec ? { exec } : {}),
  });
  const tool = tools.find((t) => t.name === "exec");
  expect(tool).toBeDefined();
  return (params: Record<string, unknown>) =>
    tool!.execute("call", {
      command: "echo probe-ok",
      timeout: 10,
      ...params,
    } as never) as Promise<ExecResult>;
}

describe("exec on the sandbox host with no sandbox configured", () => {
  it("an explicitly configured security=deny denies", async () => {
    await expect(execTool({ security: "deny" })({})).rejects.toThrow(
      /exec denied: security=deny \(sandbox host, no sandbox configured\)/,
    );
  });

  it("a requested security=deny denies", async () => {
    await expect(execTool()({ security: "deny" })).rejects.toThrow(/exec denied: security=deny/);
  });

  it.skipIf(process.platform === "win32")(
    "the unset default keeps its documented behavior",
    async () => {
      const out = await execTool()({});
      expect(out.details?.exitCode).toBe(0);
      expect(out.details?.aggregated).toContain("probe-ok");
    },
  );
});
