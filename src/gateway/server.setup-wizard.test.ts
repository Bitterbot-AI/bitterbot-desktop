/**
 * PLAN-56 Phase 4: browser setup over the wizard RPCs, end to end against a
 * real gateway: setup token in, wizard steps out, config written, token
 * spent. Uses a temporary HOME; never the real ~/.bitterbot.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { startGatewayServer } from "./server.js";
import { issueSetupToken, SETUP_TOKEN_FILE } from "./setup-token.js";
import { getFreeGatewayPort } from "./test-helpers.e2e.js";

type Res = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};
type Step = {
  id: string;
  type: string;
  message?: string;
  title?: string;
  options?: Array<{ value: unknown }>;
  initialValue?: unknown;
  section?: { id: string };
  data?: { kind?: string };
};
type NextResult = {
  done: boolean;
  status?: string;
  step?: Step;
  sessionId?: string;
  error?: string;
};

const ENV_KEYS = [
  "HOME",
  "BITTERBOT_STATE_DIR",
  "BITTERBOT_CONFIG_PATH",
  "BITTERBOT_AGENT_DIR",
  "BITTERBOT_GATEWAY_TOKEN",
  "BITTERBOT_SKIP_CHANNELS",
  "BITTERBOT_SKIP_GMAIL_WATCHER",
  "BITTERBOT_SKIP_CRON",
  "BITTERBOT_SKIP_CANVAS_HOST",
  "BITTERBOT_SKIP_BROWSER_CONTROL_SERVER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

let tempHome: string;
let port: number;
let server: Awaited<ReturnType<typeof startGatewayServer>>;
const prev: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    prev[key] = process.env[key];
  }
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-setup-e2e-"));
  process.env.HOME = tempHome;
  for (const key of [
    "BITTERBOT_STATE_DIR",
    "BITTERBOT_CONFIG_PATH",
    "BITTERBOT_AGENT_DIR",
    "BITTERBOT_GATEWAY_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    delete process.env[key];
  }
  for (const key of [
    "BITTERBOT_SKIP_CHANNELS",
    "BITTERBOT_SKIP_GMAIL_WATCHER",
    "BITTERBOT_SKIP_CRON",
    "BITTERBOT_SKIP_CANVAS_HOST",
    "BITTERBOT_SKIP_BROWSER_CONTROL_SERVER",
  ]) {
    process.env[key] = "1";
  }
  port = await getFreeGatewayPort();
  server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: "admin-token-not-used-by-setup" },
  });
}, 120_000);

afterAll(async () => {
  await server?.close({ reason: "setup e2e complete" });
  await fs.rm(tempHome, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev[key];
    }
  }
});

const stateDir = () => path.join(tempHome, ".bitterbot");

async function open(headers?: Record<string, string>): Promise<WebSocket> {
  // A browser always sends its Origin; the Control UI client id requires it.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: `http://127.0.0.1:${port}`, ...headers },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

let seq = 0;
function request(
  ws: WebSocket,
  method: string,
  params?: unknown,
  timeoutMs = 60_000,
): Promise<Res> {
  const id = `r${++seq}`;
  return new Promise<Res>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as Res;
      if (frame.type === "res" && frame.id === id) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function connectWithSetupToken(ws: WebSocket, setupToken: string) {
  return request(ws, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "bitterbot-control-ui", version: "e2e", platform: "test", mode: "ui" },
    role: "operator",
    // Self-declared scopes are ignored: a setup token gets operator.setup only.
    scopes: ["operator.admin"],
    auth: { setupToken },
  });
}

describe("browser setup over wizard.* (setup token)", () => {
  it("runs start -> each step -> complete, writes config, then spends the token", async () => {
    const { token } = issueSetupToken({ stateDir: stateDir() });
    const ws = await open();
    try {
      const hello = await connectWithSetupToken(ws, token);
      expect(hello.ok).toBe(true);
      const payload = hello.payload as {
        features: { methods: string[] };
        auth: { scopes: string[] };
        snapshot?: unknown;
      };
      expect(payload.features.methods.toSorted()).toEqual(
        ["wizard.cancel", "wizard.next", "wizard.start", "wizard.status"].toSorted(),
      );
      expect(payload.auth.scopes).toEqual(["operator.setup"]);
      expect(payload.snapshot).toBeUndefined();

      // Wizard scope only.
      for (const method of ["config.get", "health", "chat.send", "sessions.list"]) {
        const denied = await request(ws, method, {});
        expect(denied.ok).toBe(false);
        expect(denied.error?.message).toContain("wizard access only");
      }

      let res = await request(ws, "wizard.start", {});
      expect(res.ok).toBe(true);
      let next = res.payload as NextResult;
      const sessionId = next.sessionId!;

      // A reload of the setup page (same link) resumes the same session.
      const reload = await open();
      try {
        expect((await connectWithSetupToken(reload, token)).ok).toBe(true);
        const resumed = (await request(reload, "wizard.start", {})).payload as NextResult;
        expect(resumed.sessionId).toBe(sessionId);
        expect(resumed.step?.id).toBe(next.step?.id);
      } finally {
        reload.close();
      }
      // A different (forged or older) token cannot even connect.
      const intruder = await open();
      try {
        expect(
          (await connectWithSetupToken(intruder, "forged").catch(() => ({ ok: false }))).ok,
        ).toBe(false);
      } finally {
        intruder.close();
      }
      const seen: Step[] = [];
      while (!next.done) {
        const step = next.step!;
        seen.push(step);
        let value: unknown = null;
        if (step.type === "select") {
          const values = step.options?.map((o) => o.value) ?? [];
          value = values.includes("recommended")
            ? "recommended"
            : step.section?.id === "auth"
              ? "skip"
              : (step.initialValue ?? values[0]);
        }
        res = await request(ws, "wizard.next", { sessionId, answer: { stepId: step.id, value } });
        expect(res.ok).toBe(true);
        next = res.payload as NextResult;
      }
      expect(next.status).toBe("done");
      const kinds = seen.map((s) => s.data?.kind).filter(Boolean);
      expect(kinds).toEqual(["first-turn", "doctor", "done"]);

      const written = JSON.parse(
        await fs.readFile(path.join(stateDir(), "bitterbot.json"), "utf8"),
      ) as { gateway?: { mode?: string }; wizard?: { lastRunCommand?: string } };
      expect(written.gateway?.mode).toBe("local");
      expect(written.wizard?.lastRunCommand).toBe("setup");
      await expect(fs.stat(path.join(stateDir(), SETUP_TOKEN_FILE))).rejects.toThrow();
    } finally {
      ws.close();
    }

    // Spent: the same link no longer connects.
    const again = await open();
    try {
      const res = await connectWithSetupToken(again, token).catch((err: Error) => ({
        ok: false,
        error: { message: err.message },
      }));
      expect(res.ok).toBe(false);
    } finally {
      again.close();
    }

    // A fresh link after setup completed: the wizard refuses without admin.
    const fresh = issueSetupToken({ stateDir: stateDir() }).token;
    const third = await open();
    try {
      expect((await connectWithSetupToken(third, fresh)).ok).toBe(true);
      const refused = await request(third, "wizard.start", {});
      expect(refused.ok).toBe(false);
      expect(refused.error?.message).toContain("already completed");
    } finally {
      third.close();
    }
  }, 180_000);

  it("rejects an expired link and a non-loopback Host header", async () => {
    const expired = issueSetupToken({ stateDir: stateDir(), ttlMs: 1 }).token;
    await new Promise((r) => setTimeout(r, 10));
    const a = await open();
    try {
      const res = await connectWithSetupToken(a, expired).catch((err: Error) => ({
        ok: false,
        error: { message: err.message },
      }));
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("expired");
    } finally {
      a.close();
    }

    const live = issueSetupToken({ stateDir: stateDir() }).token;
    const b = await open({ Host: "evil.example", Origin: "http://evil.example" });
    try {
      const res = await request(b, "connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "test", version: "e2e", platform: "test", mode: "test" },
        role: "operator",
        auth: { setupToken: live },
      }).catch((err: Error) => ({ ok: false, error: { message: err.message } }));
      expect(res.ok).toBe(false);
    } finally {
      b.close();
    }
  }, 60_000);
});
