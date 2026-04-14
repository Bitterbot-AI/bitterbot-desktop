import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { classifyNativeSource } from "./skill-seekers-native.js";

describe("skill-seekers-native", () => {
  describe("classifyNativeSource", () => {
    it("classifies GitHub repo URLs as github", () => {
      expect(classifyNativeSource("https://github.com/nodejs/node")).toBe("github");
      expect(classifyNativeSource("https://www.github.com/nodejs/node")).toBe("github");
      expect(classifyNativeSource("https://github.com/anthropic/claude-code/tree/main")).toBe(
        "github",
      );
    });

    it("classifies generic HTTPS URLs as docs", () => {
      expect(classifyNativeSource("https://docs.python.org/3/")).toBe("docs");
      expect(classifyNativeSource("https://nextjs.org/docs/app")).toBe("docs");
      expect(classifyNativeSource("https://react.dev/reference/react")).toBe("docs");
    });

    it("defers PDFs to upstream", () => {
      expect(classifyNativeSource("https://example.com/whitepaper.pdf")).toBeNull();
      expect(classifyNativeSource("https://example.com/Docs/foo.PDF")).toBeNull();
    });

    it("defers Jupyter notebooks to upstream", () => {
      expect(classifyNativeSource("https://example.com/tutorial.ipynb")).toBeNull();
    });

    it("defers YouTube and Vimeo to upstream", () => {
      expect(classifyNativeSource("https://www.youtube.com/watch?v=abc")).toBeNull();
      expect(classifyNativeSource("https://youtu.be/abc")).toBeNull();
      expect(classifyNativeSource("https://vimeo.com/12345")).toBeNull();
      expect(classifyNativeSource("https://player.vimeo.com/video/12345")).toBeNull();
    });

    it("defers Confluence and Notion to upstream", () => {
      expect(classifyNativeSource("https://myorg.atlassian.net/wiki/spaces/ENG")).toBeNull();
      expect(classifyNativeSource("https://www.notion.so/my-page")).toBeNull();
    });

    it("returns null for malformed URLs", () => {
      expect(classifyNativeSource("not a url")).toBeNull();
      expect(classifyNativeSource("")).toBeNull();
    });
  });

  describe("output format", () => {
    it("creates a temp output dir that skill dirs can live under", () => {
      // Smoke-test that the output dir convention is filesystem-compatible.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-native-test-"));
      try {
        const skillDir = path.join(tmp, "my-skill");
        fs.mkdirSync(skillDir, { recursive: true });
        expect(fs.existsSync(skillDir)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
