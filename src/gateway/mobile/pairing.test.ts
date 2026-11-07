import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  rejectDevicePairing,
  revokeDeviceToken,
  verifyDeviceToken,
} from "../../infra/device-pairing.js";
import {
  buildClaimSignaturePayload,
  claimSetupCode,
  createSetupCode,
  deriveConfirmCode,
  readClaimStatus,
  resetMobilePairingForTests,
  SETUP_CODE_TTL_MS,
} from "./pairing.js";
import { MOBILE_CLIENT_ID, MOBILE_DEVICE_SCOPES } from "./scopes.js";

function phoneKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  const id = crypto.createHash("sha256").update(raw).digest("hex");
  const sign = (payload: string) =>
    crypto
      .sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
  return { id, publicKey: raw.toString("base64url"), sign };
}

function claimInput(code: string, key: ReturnType<typeof phoneKey>, signedAt = Date.now()) {
  return {
    code,
    device: {
      id: key.id,
      publicKey: key.publicKey,
      signedAt,
      signature: key.sign(
        buildClaimSignaturePayload({ code, deviceId: key.id, signedAtMs: signedAt }),
      ),
    },
    displayName: "Pixel 9",
    platform: "android-web",
    remoteIp: "192.168.1.20",
  };
}

let stateDir = "";
let prevStateDir: string | undefined;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-mobile-pair-"));
  prevStateDir = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = stateDir;
  resetMobilePairingForTests();
});

afterEach(async () => {
  if (prevStateDir === undefined) {
    delete process.env.BITTERBOT_STATE_DIR;
  } else {
    process.env.BITTERBOT_STATE_DIR = prevStateDir;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("mobile setup codes (PLAN-62)", () => {
  it("mints 128-bit one-time codes that expire in five minutes", () => {
    const a = createSetupCode({ now: 1000 });
    const b = createSetupCode({ now: 1000 });
    expect(a.code).not.toBe(b.code);
    expect(Buffer.from(a.code, "base64url")).toHaveLength(16);
    expect(a.expiresAtMs - 1000).toBe(SETUP_CODE_TTL_MS);
    expect(a.setupId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("files a mobile-scoped pairing request with a confirmation code both sides can derive", async () => {
    const key = phoneKey();
    const { code, setupId } = createSetupCode();
    const result = await claimSetupCode(claimInput(code, key));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmCode).toMatch(/^\d{6}$/);
    expect(result.confirmCode).toBe(deriveConfirmCode(code, key.publicKey));
    const { pending } = await listDevicePairing();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      deviceId: key.id,
      clientId: MOBILE_CLIENT_ID,
      role: "operator",
      scopes: [...MOBILE_DEVICE_SCOPES],
      setupId,
      confirmCode: result.confirmCode,
      silent: false,
      displayName: "Pixel 9",
    });
    // Nothing is paired until the owner approves.
    expect(await getPairedDevice(key.id)).toBeNull();
  });

  it("refuses a claim whose signature is not from the presented key", async () => {
    const key = phoneKey();
    const other = phoneKey();
    const { code } = createSetupCode();
    const input = claimInput(code, key);
    input.device.signature = other.sign(
      buildClaimSignaturePayload({ code, deviceId: key.id, signedAtMs: input.device.signedAt }),
    );
    const result = await claimSetupCode(input);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((await listDevicePairing()).pending).toHaveLength(0);
  });

  it("refuses a device id that is not derived from the key", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const input = claimInput(code, key);
    input.device.id = "0".repeat(64);
    expect(await claimSetupCode(input)).toMatchObject({
      ok: false,
      error: "device identity mismatch",
    });
  });

  it("refuses unknown and expired codes with the same message", async () => {
    const key = phoneKey();
    const unknown = await claimSetupCode(claimInput("A".repeat(22), key));
    const { code } = createSetupCode({ now: Date.now() - SETUP_CODE_TTL_MS - 1 });
    const expired = await claimSetupCode(claimInput(code, key));
    expect(unknown).toMatchObject({ ok: false, status: 410 });
    expect(expired).toMatchObject({ ok: false, status: 410 });
    if (!unknown.ok && !expired.ok) {
      expect(unknown.error).toBe(expired.error);
    }
  });

  it("is single use: a second device cannot claim the same code, the same device may retry", async () => {
    const key = phoneKey();
    const intruder = phoneKey();
    const { code } = createSetupCode();
    const first = await claimSetupCode(claimInput(code, key));
    expect(first.ok).toBe(true);
    expect(await claimSetupCode(claimInput(code, intruder))).toMatchObject({
      ok: false,
      status: 410,
    });
    const retry = await claimSetupCode(claimInput(code, key, Date.now() + 5));
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.claimId).toBe(first.claimId);
      expect(retry.created).toBe(false);
    }
    expect((await listDevicePairing()).pending).toHaveLength(1);
  });

  it("releases a token bound to the mobile scopes only after approval", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const claim = await claimSetupCode(claimInput(code, key));
    if (!claim.ok) throw new Error("claim failed");

    expect(await readClaimStatus({ claimId: claim.claimId, deviceId: key.id })).toMatchObject({
      status: "pending",
      confirmCode: claim.confirmCode,
    });
    // Someone else holding the claim id but another device id learns nothing.
    expect(await readClaimStatus({ claimId: claim.claimId, deviceId: phoneKey().id })).toEqual({
      status: "expired",
    });

    await approveDevicePairing(claim.request.requestId);
    const status = await readClaimStatus({ claimId: claim.claimId, deviceId: key.id });
    expect(status.status).toBe("approved");
    if (status.status !== "approved") return;
    expect(status.scopes).toEqual([...MOBILE_DEVICE_SCOPES]);

    // The token works for the phone's scopes and nothing more.
    expect(
      await verifyDeviceToken({
        deviceId: key.id,
        token: status.deviceToken,
        role: "operator",
        scopes: [...MOBILE_DEVICE_SCOPES],
      }),
    ).toEqual({ ok: true });
    expect(
      await verifyDeviceToken({
        deviceId: key.id,
        token: status.deviceToken,
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).toMatchObject({ ok: false, reason: "scope-mismatch" });

    // Revoking it kills it without touching anything else.
    await revokeDeviceToken({ deviceId: key.id, role: "operator" });
    expect(
      await verifyDeviceToken({
        deviceId: key.id,
        token: status.deviceToken,
        role: "operator",
        scopes: [...MOBILE_DEVICE_SCOPES],
      }),
    ).toMatchObject({ ok: false, reason: "token-revoked" });
  });

  it("reports a rejected claim as rejected", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const claim = await claimSetupCode(claimInput(code, key));
    if (!claim.ok) throw new Error("claim failed");
    await rejectDevicePairing(claim.request.requestId);
    expect(await readClaimStatus({ claimId: claim.claimId, deviceId: key.id })).toEqual({
      status: "rejected",
    });
  });

  it("strips control characters from the phone-supplied name", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const input = { ...claimInput(code, key), displayName: "Evil\u0007\nPhone" };
    const claim = await claimSetupCode(input);
    expect(claim.ok && claim.request.displayName).toBe("EvilPhone");
  });

  it("cannot be claimed twice by concurrent claims (the reservation is synchronous)", async () => {
    const { code } = createSetupCode();
    const keys = Array.from({ length: 6 }, () => phoneKey());
    const results = await Promise.all(keys.map((k) => claimSetupCode(claimInput(code, k))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await listDevicePairing()).pending).toHaveLength(1);
  });

  it("does not hand the claim id to a replay of the same signed request", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const signedAt = Date.now();
    expect((await claimSetupCode(claimInput(code, key, signedAt))).ok).toBe(true);
    expect(await claimSetupCode(claimInput(code, key, signedAt))).toMatchObject({
      ok: false,
      status: 410,
    });
  });

  it("lets the claimant collect again for a short while (lost response), then the claim is gone", async () => {
    const key = phoneKey();
    const { code } = createSetupCode();
    const claim = await claimSetupCode(claimInput(code, key));
    if (!claim.ok) throw new Error("claim failed");
    await approveDevicePairing(claim.request.requestId);
    const first = await readClaimStatus({ claimId: claim.claimId, deviceId: key.id });
    expect(first.status).toBe("approved");
    const t0 = Date.now();
    // A retry after a dropped response gets the same token.
    expect(
      await readClaimStatus({ claimId: claim.claimId, deviceId: key.id, now: t0 + 30_000 }),
    ).toEqual(first);
    // Only the claimant: the right claim id with another device id gets nothing.
    expect(
      (
        await readClaimStatus({
          claimId: claim.claimId,
          deviceId: "someone-else",
          now: t0 + 30_000,
        })
      ).status,
    ).toBe("expired");
    // After the grace window the claim is gone.
    expect(
      await readClaimStatus({ claimId: claim.claimId, deviceId: key.id, now: t0 + 3 * 60_000 }),
    ).toEqual({ status: "expired" });
  });
});

describe("pairing address labels (PLAN-62)", () => {
  it("labels two addresses of the same kind distinctly", async () => {
    const { labelDistinctly } = await import("./urls.js");
    expect(
      labelDistinctly([
        { url: "http://192.168.1.5:19001", label: "Home network", secure: false },
        { url: "http://10.0.0.7:19001", label: "Home network", secure: false },
        { url: "https://box.tail.ts.net", label: "Tailscale", secure: true },
      ]).map((u) => u.label),
    ).toEqual(["Home network (192.168.1.5)", "Home network (10.0.0.7)", "Tailscale"]);
  });
});
