/**
 * The install one-liners in the docs must agree with each other and with the
 * URL the CLI prints (INSTALL_SH_URL). A page that teaches another URL (an old
 * branch, a fictional domain) sends people to a script nobody tests.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_SH_URL } from "./install-kind.js";

const ROOT = process.cwd();
const INSTALL_PS1_URL = INSTALL_SH_URL.replace(/install\.sh$/, "install.ps1");
// A release's own copy, for pinned installs.
const PINNED_RELEASE_ASSET =
  /^https:\/\/github\.com\/Bitterbot-AI\/bitterbot-desktop\/releases\/download\/v\d+\.\d+\.\d+\/install\.sh$/;

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...markdownFiles(full));
    } else if (/\.mdx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function installerUrls(): Array<{ file: string; url: string }> {
  const files = [...markdownFiles(path.join(ROOT, "docs")), path.join(ROOT, "README.md")];
  const found: Array<{ file: string; url: string }> = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/https?:\/\/[^\s)"'`<>]*\/install\.(?:sh|ps1)\b/g)) {
      found.push({ file: path.relative(ROOT, file), url: match[0] });
    }
  }
  return found;
}

describe("installer URLs in the docs", () => {
  it("are the canonical one-liner URL (or a pinned release asset)", () => {
    const urls = installerUrls();
    expect(urls.length).toBeGreaterThan(0);
    const wrong = urls.filter(
      ({ url }) =>
        url !== INSTALL_SH_URL && url !== INSTALL_PS1_URL && !PINNED_RELEASE_ASSET.test(url),
    );
    expect(wrong).toEqual([]);
  });

  it("include the canonical one-liner on the installer page", () => {
    const page = fs.readFileSync(path.join(ROOT, "docs", "start", "install-script.md"), "utf8");
    expect(page).toContain(`curl -fsSL ${INSTALL_SH_URL} | bash`);
    expect(page).toContain(`irm ${INSTALL_PS1_URL} | iex`);
  });
});
