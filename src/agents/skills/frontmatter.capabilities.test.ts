/**
 * PLAN-13 Phase B: tests for the `bitterbot.capabilities` frontmatter parser.
 *
 * The repo's manifest convention is a `metadata:` key holding a JSON5 blob
 * with a `bitterbot` root object. We follow that here so the capabilities
 * declaration sits alongside `requires`, `install`, etc.
 *
 * The parser is intentionally permissive — malformed shapes are dropped
 * rather than throwing — but it must never expand "missing" to "allow."
 * The profile resolver fills missing axes from the trust-tier baseline,
 * not the parser.
 */

import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveBitterbotMetadata } from "./frontmatter.js";

function parseCaps(bitterbot: Record<string, unknown>) {
  const fm = parseFrontmatter(
    `---\nname: x\ndescription: x.\nmetadata: ${JSON.stringify({ bitterbot })}\n---\n`,
  );
  return resolveBitterbotMetadata(fm)?.capabilities;
}

describe("frontmatter capabilities parser", () => {
  it("parses a fully-specified capabilities block", () => {
    const caps = parseCaps({
      capabilities: {
        network: { outbound: ["api.openweathermap.org", "wttr.in"] },
        fs: { read: ["/tmp/weather/"], write: ["/tmp/weather/"] },
        wallet: false,
        shell: false,
        process: false,
      },
    });
    expect(caps).toBeDefined();
    expect(caps?.network).toEqual({
      outbound: ["api.openweathermap.org", "wttr.in"],
    });
    expect(caps?.fs).toEqual({ read: ["/tmp/weather/"], write: ["/tmp/weather/"] });
    expect(caps?.wallet).toBe(false);
    expect(caps?.shell).toBe(false);
    expect(caps?.process).toBe(false);
  });

  it("treats `network: false` as deny-axis", () => {
    const caps = parseCaps({ capabilities: { network: false } });
    expect(caps?.network).toBe(false);
  });

  it("treats `fs: false` as deny-axis", () => {
    const caps = parseCaps({ capabilities: { fs: false } });
    expect(caps?.fs).toBe(false);
  });

  it("returns undefined when no bitterbot block is present", () => {
    const fm = parseFrontmatter(`---\nname: x\ndescription: x.\n---\n`);
    expect(resolveBitterbotMetadata(fm)?.capabilities).toBeUndefined();
  });

  it("returns undefined when bitterbot exists but has no capabilities key", () => {
    const caps = parseCaps({ emoji: "⭐" });
    expect(caps).toBeUndefined();
  });

  it("ignores malformed wallet value (string instead of boolean)", () => {
    const caps = parseCaps({ capabilities: { wallet: "yes" } });
    expect(caps?.wallet).toBeUndefined();
  });

  it("does not auto-grant axes the publisher omitted", () => {
    const caps = parseCaps({ capabilities: { network: false } });
    // Parser only knows what was declared; resolver fills the rest.
    expect(caps?.network).toBe(false);
    expect(caps?.wallet).toBeUndefined();
    expect(caps?.shell).toBeUndefined();
    expect(caps?.process).toBeUndefined();
    expect(caps?.fs).toBeUndefined();
  });
});
