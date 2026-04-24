import { describe, expect, it } from "vitest";
import { resolveAgentskillsUrl } from "./agentskills-fetch.js";

describe("resolveAgentskillsUrl", () => {
  it("passes through a direct https URL", () => {
    const result = resolveAgentskillsUrl("https://agentskills.io/skills/foo/SKILL.md");
    expect(result).toEqual({ url: "https://agentskills.io/skills/foo/SKILL.md" });
  });

  it("resolves a slug against the default registry", () => {
    const result = resolveAgentskillsUrl("github-release");
    expect(result).toEqual({
      url: "https://agentskills.io/skills/github-release/SKILL.md",
      slug: "github-release",
    });
  });

  it("honors a custom registryBaseUrl", () => {
    const result = resolveAgentskillsUrl("foo", {
      registryBaseUrl: "https://mirror.example/",
    });
    expect(result).toEqual({
      url: "https://mirror.example/skills/foo/SKILL.md",
      slug: "foo",
    });
  });

  it("rejects plaintext http", () => {
    const result = resolveAgentskillsUrl("http://example.com/s/x/SKILL.md");
    expect(result).toEqual({ error: expect.stringContaining("https") });
  });

  it("rejects empty input", () => {
    expect(resolveAgentskillsUrl("")).toEqual({ error: "empty input" });
  });

  it("rejects path-like input", () => {
    expect(resolveAgentskillsUrl("./relative")).toHaveProperty("error");
    expect(resolveAgentskillsUrl("/abs/path")).toHaveProperty("error");
  });

  it("normalizes slug characters", () => {
    const result = resolveAgentskillsUrl("  Foo Bar!  ");
    expect(result).toEqual({
      url: "https://agentskills.io/skills/foo-bar/SKILL.md",
      slug: "foo-bar",
    });
  });
});
