import { describe, expect, it } from "vitest";
import { sessionTitle } from "./components/Chrome";
import { formatConfirmCode, guessDeviceName, guessPlatform } from "./pairing-client";
import { parseRoute } from "./route";
import { MOBILE_SCOPES } from "./store";

describe("phone app helpers (PLAN-62)", () => {
  it("routes hash URLs from notifications", () => {
    expect(parseRoute("#/approvals?id=rv-1").tab).toBe("approvals");
    expect(parseRoute("#/approvals?id=rv-1").params.get("id")).toBe("rv-1");
    expect(parseRoute("#/chat?session=agent%3Amain%3Adefault").params.get("session")).toBe(
      "agent:main:default",
    );
    expect(parseRoute("#/nonsense").tab).toBe("chat");
    expect(parseRoute("").tab).toBe("chat");
  });

  it("names the phone from its user agent", () => {
    expect(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)")).toBe(
      "iPhone",
    );
    expect(guessDeviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) Chrome/130")).toBe(
      "Pixel 8",
    );
    expect(guessDeviceName("Mozilla/5.0 (Linux; Android 14; K) Chrome/130")).toBe("Android phone");
    expect(guessPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)")).toBe("ios-web");
  });

  it("formats the confirmation code in two groups", () => {
    expect(formatConfirmCode("472913")).toBe("472 913");
  });

  it("gives the main conversation a friendly name", () => {
    expect(
      sessionTitle("default", [{ key: "agent:main:default", derivedTitle: "74689b17 (2026)" }]),
    ).toBe("Main chat");
    expect(sessionTitle("default", [{ key: "agent:main:default", label: "Home" }])).toBe("Home");
    expect(
      sessionTitle("agent:main:trip", [{ key: "agent:main:trip", derivedTitle: "Trip plans" }]),
    ).toBe("Trip plans");
  });

  it("asks for exactly the gateway's phone scopes", () => {
    expect(MOBILE_SCOPES).toEqual([
      "operator.approvals",
      "operator.chat",
      "operator.notifications",
    ]);
  });
});
