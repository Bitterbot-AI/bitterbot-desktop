import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing.js";

async function setupPairedOperatorDevice(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, baseDir);
}

function requireToken(token: string | undefined): string {
  expect(typeof token).toBe("string");
  if (typeof token !== "string") {
    throw new Error("expected operator token to be issued");
  }
  return token;
}

describe("device pairing tokens", () => {
  test("generates base64url device tokens with 256-bit entropy output length", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "bitterbot-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("preserves existing token scopes when rotating without scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "bitterbot-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.read"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("verifies token and rejects mismatches", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "bitterbot-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);

    const ok = await verifyDeviceToken({
      deviceId: "device-1",
      token,
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyDeviceToken({
      deviceId: "device-1",
      token: "x".repeat(token.length),
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "bitterbot-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: multibyteToken,
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
  });

  test("marks a phone paired before principal existed, from its approved scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "bitterbot-device-pairing-"));
    await mkdir(join(baseDir, "devices"), { recursive: true });
    const token = (scopes: string[]) => ({
      operator: { token: "t", role: "operator", scopes, createdAtMs: 1 },
    });
    // A pairings file written by the gateway before PLAN-62 added `principal`.
    await writeFile(
      join(baseDir, "devices", "paired.json"),
      JSON.stringify({
        phone: {
          deviceId: "phone",
          publicKey: "k1",
          role: "operator",
          scopes: ["operator.approvals", "operator.chat", "operator.notifications"],
          tokens: token(["operator.approvals", "operator.chat", "operator.notifications"]),
          createdAtMs: 1,
          approvedAtMs: 1,
        },
        desktop: {
          deviceId: "desktop",
          publicKey: "k2",
          role: "operator",
          scopes: ["operator.admin", "operator.approvals"],
          tokens: token(["operator.admin", "operator.approvals"]),
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    );

    expect((await getPairedDevice("phone", baseDir))?.principal).toBe("phone");
    expect((await getPairedDevice("desktop", baseDir))?.principal).toBeUndefined();
  });
});
