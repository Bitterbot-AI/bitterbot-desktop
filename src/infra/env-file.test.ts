import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertSharedEnvVar } from "./env-file.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-env-file-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ BITTERBOT_STATE_DIR: dir }) as NodeJS.ProcessEnv;
const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe.skipIf(process.platform === "win32")("upsertSharedEnvVar file mode", () => {
  it("creates the shared .env readable by its owner only", () => {
    const res = upsertSharedEnvVar({ key: "OPENAI_API_KEY", value: "sk-new", env: env() });
    expect(res.created).toBe(true);
    expect(mode(res.path)).toBe(0o600);
    expect(fs.readFileSync(res.path, "utf8")).toBe("OPENAI_API_KEY=sk-new\n");
  });

  it("tightens an existing world-readable .env and keeps its other lines", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "OTHER=1\nOPENAI_API_KEY=sk-old\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    upsertSharedEnvVar({ key: "OPENAI_API_KEY", value: "sk-new", env: env() });
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("OTHER=1\nOPENAI_API_KEY=sk-new\n");
  });
});
