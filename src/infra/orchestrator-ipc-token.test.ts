import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IPC_TOKEN_FILENAME, ipcAuthLine, loadOrCreateIpcToken } from "./orchestrator-ipc-token.js";

describe("orchestrator IPC token", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-token-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("creates a 256-bit hex token once and reuses it across restarts", () => {
    const dir = tmp();
    const a = loadOrCreateIpcToken(dir);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateIpcToken(dir)).toBe(a);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, IPC_TOKEN_FILENAME)).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an unusable token file", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, IPC_TOKEN_FILENAME), "garbage");
    expect(loadOrCreateIpcToken(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("frames the auth line the daemon expects", () => {
    const parsed = JSON.parse(ipcAuthLine("abc")) as { type: string; payload: { token: string } };
    expect(parsed.type).toBe("auth");
    expect(parsed.payload.token).toBe("abc");
  });
});
