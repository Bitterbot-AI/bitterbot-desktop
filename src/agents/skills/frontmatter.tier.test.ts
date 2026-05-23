import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveBitterbotMetadata } from "./frontmatter.js";

describe("frontmatter tier + interceptors[]", () => {
  it("parses top-level tier into the metadata", () => {
    const fm = parseFrontmatter(`---
name: foo
description: x
tier: executable
---
body`);
    const meta = resolveBitterbotMetadata(fm);
    expect(meta?.tier).toBe("executable");
  });

  it("accepts tier inside the bitterbot block", () => {
    const fm = parseFrontmatter(`---
name: foo
description: x
bitterbot:
  tier: data
---
body`);
    const meta = resolveBitterbotMetadata(fm);
    expect(meta?.tier).toBe("data");
  });

  it("parses declared interceptors[]", () => {
    const fm = parseFrontmatter(`---
name: foo
description: x
tier: executable
bitterbot:
  interceptors:
    - id: "foo:default"
      builtin: true
      activates_on: send_message
      intervention: modify
---
body`);
    const meta = resolveBitterbotMetadata(fm);
    expect(meta?.interceptors).toEqual([
      expect.objectContaining({ id: "foo:default", builtin: true }),
    ]);
  });

  it("rejects invalid tier values silently (undefined)", () => {
    const fm = parseFrontmatter(`---
name: foo
description: x
tier: nonsense
---
body`);
    const meta = resolveBitterbotMetadata(fm);
    expect(meta?.tier).toBeUndefined();
  });

  it("returns metadata even when only tier is present (no bitterbot block)", () => {
    const fm = parseFrontmatter(`---
name: foo
description: x
tier: advisory
---
body`);
    const meta = resolveBitterbotMetadata(fm);
    expect(meta?.tier).toBe("advisory");
  });
});
