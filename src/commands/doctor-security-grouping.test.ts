import { describe, expect, it } from "vitest";
import { groupSecurityWarnings } from "./doctor-security.js";

describe("groupSecurityWarnings", () => {
  it("opens a finding per '- ' line and joins indented continuations", () => {
    const results = groupSecurityWarnings([
      "- CRITICAL: Gateway bound to lan without authentication.",
      "  Anyone on your network can fully control your agent.",
      "  Fix: bitterbot config set gateway.bind loopback",
      '- WhatsApp DMs: OPEN (policy="open"). Anyone can DM it.',
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.level).toBe("warn");
    expect(results[0]?.message).toContain("CRITICAL");
    expect(results[0]?.message).toContain("Fix: bitterbot config set gateway.bind loopback");
    expect(results[1]?.level).toBe("warn");
  });

  it("classifies deliberate lockdown states as info, not warn", () => {
    // "disabled" and "locked with no allowlist" are safe configurations the
    // operator chose — a hardened node's --json must not read as degraded.
    const results = groupSecurityWarnings([
      '- Telegram DMs: disabled (policy="disabled").',
      '- WhatsApp DMs: locked (policy="pairing") with no allowlist; unknown senders will be blocked / get a pairing code.',
      "  approve hint here",
      '- Signal DMs: OPEN (policy="open").',
    ]);
    expect(results[0]?.level).toBe("info");
    expect(results[1]?.level).toBe("info");
    expect(results[1]?.message).toContain("approve hint here");
    expect(results[2]?.level).toBe("warn");
  });
});
