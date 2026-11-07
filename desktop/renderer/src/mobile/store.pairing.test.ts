import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claimSetupCode = vi.fn();
const readClaimStatus = vi.fn();

vi.mock("./pairing-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pairing-client")>()),
  claimSetupCode: (...args: unknown[]) => claimSetupCode(...args),
  readClaimStatus: (...args: unknown[]) => readClaimStatus(...args),
}));
vi.mock("../lib/device-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/device-identity")>()),
  loadOrCreateDeviceIdentity: async () => ({ deviceId: "dev-1", publicKey: "pk" }),
  clearDeviceIdentity: async () => {},
}));
vi.mock("../lib/gateway-client", () => ({
  GatewayClient: class {
    start() {}
    stop() {}
    halt() {}
    request() {
      return Promise.reject(new Error("gateway unreachable"));
    }
  },
}));

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";

async function freshStore() {
  vi.resetModules();
  return await import("./store");
}

function asIphone(standalone: boolean) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: query.includes("standalone") && standalone }) as MediaQueryList,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  claimSetupCode.mockReset();
  readClaimStatus.mockReset();
  claimSetupCode.mockResolvedValue({ claimId: "claim-1", localConfirmCode: "123456" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "bb_pair_handoff=; Max-Age=0; Path=/";
});

describe("phone pairing flow (PLAN-62)", () => {
  it("iPhone Safari holds the link, and the Home Screen app pairs with it", async () => {
    asIphone(false);
    const safari = await freshStore();
    safari.useMobile.getState().receivePairCode(CODE);
    expect(safari.useMobile.getState().phase).toBe("install");
    expect(claimSetupCode).not.toHaveBeenCalled();

    // The installed app: separate storage, but the cookie came across.
    localStorage.clear();
    asIphone(true);
    const app = await freshStore();
    void app.useMobile.getState().boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimSetupCode).toHaveBeenCalledWith(CODE, expect.anything(), expect.any(String));
    expect(app.useMobile.getState().pairing?.confirmCode).toBe("123456");
    // Read once: a second launch does not claim again.
    expect(document.cookie).not.toContain("bb_pair_handoff=A");
  });

  it("can still pair in Safari when asked", async () => {
    asIphone(false);
    const { useMobile } = await freshStore();
    useMobile.getState().receivePairCode(CODE);
    useMobile.getState().pairInBrowserInstead();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimSetupCode).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toContain("bb_pair_handoff=A");
  });

  it("resumes waiting for the owner after a reload", async () => {
    readClaimStatus.mockResolvedValue({ status: "pending" });
    const first = await freshStore();
    void first.useMobile.getState().startPairing(CODE);
    await vi.advanceTimersByTimeAsync(0);

    readClaimStatus.mockResolvedValue({
      status: "approved",
      deviceToken: "tok",
      deviceId: "dev-1",
      scopes: [],
    });
    const reloaded = await freshStore();
    void reloaded.useMobile.getState().boot();
    expect(reloaded.useMobile.getState().phase).toBe("pairing");
    await vi.advanceTimersByTimeAsync(3000);
    expect(readClaimStatus).toHaveBeenLastCalledWith("claim-1", "dev-1");
    expect(reloaded.useMobile.getState().phase).toBe("ready");
    expect(JSON.parse(localStorage.getItem("bitterbot-mobile-v1") ?? "{}")).toMatchObject({
      deviceToken: "tok",
    });
  });

  it("an older pairing loop cannot overwrite a newer one", async () => {
    readClaimStatus.mockResolvedValue({ status: "pending" });
    const { useMobile } = await freshStore();
    void useMobile.getState().startPairing(CODE);
    await vi.advanceTimersByTimeAsync(0);
    claimSetupCode.mockResolvedValue({ claimId: "claim-2", localConfirmCode: "654321" });
    void useMobile.getState().startPairing(`${CODE}x`);
    await vi.advanceTimersByTimeAsync(0);
    readClaimStatus.mockImplementation(async (claimId: string) =>
      claimId === "claim-1" ? { status: "rejected" } : { status: "pending" },
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(useMobile.getState().pairing).toMatchObject({ step: "waiting", confirmCode: "654321" });
    expect(readClaimStatus.mock.calls.every(([id]) => id === "claim-2")).toBe(true);
  });

  it("says when the code ran out, apart from a decline", async () => {
    readClaimStatus.mockResolvedValue({ status: "expired" });
    const { useMobile } = await freshStore();
    void useMobile.getState().startPairing(CODE);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMobile.getState().pairing).toMatchObject({ step: "failed", reason: "expired" });
  });

  it("does not claim it unpaired when the computer never confirmed", async () => {
    localStorage.setItem(
      "bitterbot-mobile-v1",
      JSON.stringify({ deviceToken: "tok", deviceId: "dev-1" }),
    );
    const { useMobile } = await freshStore();
    await useMobile.getState().boot();
    const error = await useMobile.getState().unpair();
    expect(error).toContain("gateway unreachable");
    expect(useMobile.getState().phase).toBe("ready");
    expect(localStorage.getItem("bitterbot-mobile-v1")).toContain("tok");

    expect(await useMobile.getState().unpair({ force: true })).toBeNull();
    expect(useMobile.getState().phase).toBe("welcome");
    expect(useMobile.getState().unpairedReason).toContain("Remove it under Devices");
  });
});

describe("storage refused (private browsing)", () => {
  it("keeps the pairing in memory instead of losing it", async () => {
    const { readPersisted, writePersisted } = await import("./persist");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    writePersisted({ deviceToken: "tok" });
    expect(readPersisted().deviceToken).toBe("tok");
  });
});
