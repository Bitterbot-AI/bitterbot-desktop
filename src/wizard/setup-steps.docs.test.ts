import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P2P_EGRESS_SENTENCE } from "./setup-steps.js";

const normalize = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");

describe("setup's P2P sentence", () => {
  it("is quoted word for word in docs/network/egress.md", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "docs", "network", "egress.md"), "utf8");
    expect(normalize(doc)).toContain(P2P_EGRESS_SENTENCE);
  });
});
