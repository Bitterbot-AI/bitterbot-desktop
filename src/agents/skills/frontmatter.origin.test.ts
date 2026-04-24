import { describe, expect, it } from "vitest";
import { resolveBitterbotMetadata } from "./frontmatter.js";

describe("resolveBitterbotMetadata origin parsing", () => {
  it("returns undefined when no metadata block is present", () => {
    expect(resolveBitterbotMetadata({})).toBeUndefined();
  });

  it("parses an origin block from imported skills", () => {
    const metadata = resolveBitterbotMetadata({
      metadata: JSON.stringify({
        bitterbot: {
          origin: {
            registry: "agentskills.io",
            slug: "github-release",
            version: "1.2.0",
            license: "MIT",
            upstreamUrl: "https://agentskills.io/skills/github-release/SKILL.md",
          },
        },
      }),
    });
    expect(metadata?.origin).toEqual({
      registry: "agentskills.io",
      slug: "github-release",
      version: "1.2.0",
      license: "MIT",
      upstreamUrl: "https://agentskills.io/skills/github-release/SKILL.md",
    });
  });

  it("accepts snake_case upstream_url as a fallback", () => {
    const metadata = resolveBitterbotMetadata({
      metadata: JSON.stringify({
        bitterbot: {
          origin: {
            registry: "agentskills.io",
            upstream_url: "https://agentskills.io/skills/x/SKILL.md",
          },
        },
      }),
    });
    expect(metadata?.origin?.upstreamUrl).toBe("https://agentskills.io/skills/x/SKILL.md");
  });

  it("leaves origin undefined when the block is empty", () => {
    const metadata = resolveBitterbotMetadata({
      metadata: JSON.stringify({
        bitterbot: { origin: {} },
      }),
    });
    expect(metadata?.origin).toBeUndefined();
  });
});
