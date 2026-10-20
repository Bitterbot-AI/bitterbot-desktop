import { describe, expect, it } from "vitest";
import {
  CLASS_CEILING,
  classifyForEgress,
  egressPermitted,
  groupByClass,
  resolvePoolTrust,
} from "./egress.js";

describe("egress policy", () => {
  it("maps classes to the least trusted pool they may reach", () => {
    expect(CLASS_CEILING).toEqual({
      confidential: "local",
      personal: "trusted",
      normal: "untrusted",
    });
    expect(egressPermitted("confidential", "local")).toBe(true);
    expect(egressPermitted("confidential", "trusted")).toBe(false);
    expect(egressPermitted("personal", "trusted")).toBe(true);
    expect(egressPermitted("personal", "untrusted")).toBe(false);
    expect(egressPermitted("normal", "untrusted")).toBe(true);
  });

  it("takes pool trust from config, local for the local pool, untrusted otherwise", () => {
    expect(resolvePoolTrust(undefined, "local")).toBe("local");
    expect(resolvePoolTrust(undefined, "lab")).toBe("untrusted");
    expect(resolvePoolTrust({ compute: { pools: { lab: { trust: "trusted" } } } }, "lab")).toBe(
      "trusted",
    );
    // The local pool cannot be demoted or another pool promoted to local by config.
    expect(
      resolvePoolTrust({ compute: { pools: { local: { trust: "untrusted" } } } }, "local"),
    ).toBe("local");
  });

  it("classifies by source default, raised by the text, and treats unknown sources as personal", () => {
    expect(classifyForEgress({ text: "the build runs on CI", source: "memory" })).toBe("normal");
    expect(classifyForEgress({ text: "the build runs on CI", source: "sessions" })).toBe(
      "personal",
    );
    expect(
      classifyForEgress({
        text: "the build runs on CI",
        source: "sessions",
        config: { compute: { egress: { transcriptsDefaultClass: "normal" } } },
      }),
    ).toBe("normal");
    expect(classifyForEgress({ text: "my api key is abc", source: "memory" })).toBe("confidential");
    expect(classifyForEgress({ text: "my therapist said", source: "memory" })).toBe("personal");
    expect(classifyForEgress({ text: "plain" })).toBe("personal");
    // The transcript class is a floor, never a ceiling.
    expect(
      classifyForEgress({
        text: "the password is hunter2",
        source: "sessions",
        config: { compute: { egress: { transcriptsDefaultClass: "normal" } } },
      }),
    ).toBe("confidential");
  });

  it("groups indices by class in first-seen order", () => {
    const g = groupByClass(["normal", "personal", "normal", "confidential"]);
    expect([...g.entries()]).toEqual([
      ["normal", [0, 2]],
      ["personal", [1]],
      ["confidential", [3]],
    ]);
  });
});
