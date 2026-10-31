import { expect, it } from "vitest";
import { beginSoapboxTransition, withSoapboxOperation } from "./soapbox-transition.js";

it("blocks switching during a transaction and blocks mutations until the new profile is loaded", async () => {
  await withSoapboxOperation(async () => {
    expect(() => beginSoapboxTransition()).toThrow("busy");
    await withSoapboxOperation(async () => {});
  });
  const release = beginSoapboxTransition();
  try {
    await expect(withSoapboxOperation(async () => "must not run")).rejects.toThrow(
      "profile is changing",
    );
  } finally {
    release();
  }
  await expect(withSoapboxOperation(async () => "ready")).resolves.toBe("ready");
});
