import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_CREDENTIAL_ENV } from "./known-env-vars.js";

/**
 * Credential-looking names the code reads that are deliberately NOT in
 * KNOWN_CREDENTIAL_ENV. Each needs a reason.
 */
const IGNORED = new Map<string, string>([
  ["MY_API_KEY", "example name in help text"],
  ["MISSING_API_KEY", "example name in an error message"],
]);

const CREDENTIAL_RE = /(?:API_KEY|_TOKEN|_SECRET|SECRET_KEY|_PASSWORD|_KEY_ID)$/;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

describe("KNOWN_CREDENTIAL_ENV stays in step with the code", () => {
  it("lists every credential variable the code reads from process.env", () => {
    const files: string[] = [];
    for (const root of ["src", "extensions"]) {
      const dir = path.join(process.cwd(), root);
      if (fs.existsSync(dir)) {
        walk(dir, files);
      }
    }
    const found = new Set<string>();
    const re = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? m[2];
        if (name && CREDENTIAL_RE.test(name)) {
          found.add(name);
        }
      }
    }
    expect(found.size).toBeGreaterThan(10);
    const missing = [...found].filter(
      (name) =>
        !KNOWN_CREDENTIAL_ENV.has(name) && !name.startsWith("BITTERBOT_") && !IGNORED.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("knows the providers' alternative variables and the cloud keys", () => {
    for (const name of [
      "COPILOT_GITHUB_TOKEN",
      "CHUTES_OAUTH_TOKEN",
      "Z_AI_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "QWEN_OAUTH_TOKEN",
      "MINIMAX_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "SLACK_USER_TOKEN",
      "STRIPE_SECRET_KEY",
    ]) {
      expect(KNOWN_CREDENTIAL_ENV.has(name), name).toBe(true);
    }
    expect(KNOWN_CREDENTIAL_ENV.has("CLAUDE_CODE_MESSAGING_TOKEN")).toBe(false);
  });
});
