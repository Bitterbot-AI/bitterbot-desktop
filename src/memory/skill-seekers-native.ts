/**
 * Native TypeScript scraper for Skill Seekers — zero-install hybrid path.
 *
 * Generates SKILL.md + references/*.md matching the format produced by upstream
 * Skill Seekers (https://github.com/yusufkaraaslan/Skill_Seekers by Yusuf
 * Karaaslan, MIT License). This module is for the common-case sources (HTML
 * documentation sites and GitHub repositories) where a full Python install
 * isn't worth the friction. The upstream transports remain available for
 * PDFs, video transcripts, Jupyter notebooks, Confluence, Notion, OpenAPI,
 * and other complex source types.
 *
 * Design goals:
 *   - Reuse the hardened `fetchWithSsrFGuard` (SSRF protection, DNS pinning,
 *     timeouts) so scraping has the same safety profile as web_fetch.
 *   - Use `extractReadableContent` (Mozilla Readability) to strip chrome and
 *     get the article body — the same code that powers web_fetch.
 *   - Output format is byte-compatible with upstream Skill Seekers: a
 *     directory containing SKILL.md with YAML frontmatter plus optional
 *     references/*.md files.
 *   - Credit Yusuf Karaaslan in frontmatter metadata for schema parity.
 */

import fs from "node:fs";
import path from "node:path";
import { extractReadableContent, htmlToMarkdown } from "../agents/tools/web-fetch-utils.js";
import { readResponseText } from "../agents/tools/web-shared.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-seekers-native");

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024; // 2 MB per page — enough for big docs
const MAX_GITHUB_FILE_BYTES = 500_000; // 500 KB per GitHub file
const MAX_REFERENCES = 10; // Cap the references/ directory for sanity
const GITHUB_API_ROOT = "https://api.github.com";

// ── Types ──

export type NativeScrapeRequest = {
  url: string;
  name?: string;
  description?: string;
  /** Directory where SKILL.md + references/ will be written. Adapter creates the skill subdir. */
  outputDir: string;
};

export type NativeScrapeResult = {
  ok: boolean;
  skillDir?: string;
  kind?: "docs" | "github";
  error?: string;
};

/**
 * Decide whether this URL is a good fit for the native scraper.
 * Returns the source kind when native can handle it, null otherwise.
 *
 * Native coverage:
 *   - github.com/<owner>/<repo> → GitHub API path
 *   - Any other http(s) URL → treated as a docs site (HTML → markdown)
 *
 * Native does NOT handle: PDFs, videos, Jupyter notebooks, Confluence, Notion.
 * Those URL patterns return null so the adapter falls back to upstream.
 */
export function classifyNativeSource(url: string): "docs" | "github" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const pathLower = parsed.pathname.toLowerCase();

  // Hosts / extensions native can't parse — defer to upstream
  if (pathLower.endsWith(".pdf")) {
    return null;
  }
  if (pathLower.endsWith(".ipynb")) {
    return null;
  }
  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "youtu.be") {
    return null;
  }
  if (hostname === "vimeo.com" || hostname.endsWith(".vimeo.com")) {
    return null;
  }
  if (hostname.endsWith(".atlassian.net")) {
    // Confluence
    return null;
  }
  if (hostname === "www.notion.so" || hostname === "notion.so") {
    return null;
  }

  if (hostname === "github.com" || hostname === "www.github.com") {
    return "github";
  }
  return "docs";
}

/**
 * Run the native scraper against a URL, writing SKILL.md + references/*.md
 * into a new subdirectory of `outputDir` (matching upstream's convention).
 */
export async function runNativeScraper(request: NativeScrapeRequest): Promise<NativeScrapeResult> {
  const kind = classifyNativeSource(request.url);
  if (!kind) {
    return { ok: false, error: "native_scraper_unsupported_url" };
  }

  try {
    if (kind === "github") {
      return await scrapeGithub(request);
    }
    return await scrapeDocsSite(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Native scraper failed for ${request.url}: ${message}`);
    return { ok: false, error: message };
  }
}

// ── Docs site scraping ──

async function scrapeDocsSite(request: NativeScrapeRequest): Promise<NativeScrapeResult> {
  const { text, title } = await fetchAndExtract(request.url);
  if (!text || text.trim().length === 0) {
    return { ok: false, error: "no_readable_content" };
  }

  const name = request.name ?? slugifyFromUrl(request.url, title);
  const description = request.description ?? title ?? `Documentation scraped from ${request.url}`;
  const skillDir = prepareSkillDir(request.outputDir, name);

  const skillMd = buildSkillMd({
    name,
    description,
    sourceUrl: request.url,
    sourceType: "docs",
    body: text,
  });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf8");

  return { ok: true, skillDir, kind: "docs" };
}

async function fetchAndExtract(
  url: string,
): Promise<{ text: string; title?: string; finalUrl: string }> {
  const guarded = await fetchWithSsrFGuard({
    url,
    init: {
      headers: {
        "User-Agent": "Bitterbot-SkillSeekers/1.0 (+https://bitterbot.ai)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 4,
    auditContext: "skill-seekers-native",
  });
  try {
    const { response, finalUrl } = guarded;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${finalUrl}`);
    }
    const { text: html } = await readResponseText(response, { maxBytes: MAX_PAGE_BYTES });
    const extracted = await extractReadableContent({
      html,
      url: finalUrl,
      extractMode: "markdown",
    });
    if (extracted) {
      return { text: extracted.text, title: extracted.title, finalUrl };
    }
    // Extraction returned null (pathological HTML) — fall back to simple conversion.
    const fallback = htmlToMarkdown(html);
    return { text: fallback.text, title: fallback.title, finalUrl };
  } finally {
    await guarded.release();
  }
}

// ── GitHub repo scraping ──

type GithubContentEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  download_url?: string | null;
};

type GithubRepoInfo = {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
  stargazers_count?: number;
  language?: string | null;
};

async function scrapeGithub(request: NativeScrapeRequest): Promise<NativeScrapeResult> {
  const parsed = parseGithubUrl(request.url);
  if (!parsed) {
    return { ok: false, error: "not_a_github_repo_url" };
  }

  // Repo metadata
  const repo = await githubApi<GithubRepoInfo>(
    `${GITHUB_API_ROOT}/repos/${parsed.owner}/${parsed.repo}`,
  );
  if (!repo) {
    return { ok: false, error: "github_repo_not_found" };
  }

  // README
  const readme = await fetchGithubReadme(parsed.owner, parsed.repo);

  // docs/ directory (best-effort — many repos don't have one)
  const docsFiles = await fetchGithubDocsDirectory(parsed.owner, parsed.repo);

  const name = request.name ?? repo.name.toLowerCase();
  const description =
    request.description ?? repo.description ?? `GitHub repository: ${repo.full_name}`;
  const skillDir = prepareSkillDir(request.outputDir, name);

  // Compose SKILL.md body from repo metadata + README
  const bodyParts: string[] = [];
  bodyParts.push(`# ${repo.full_name}`);
  if (repo.description) {
    bodyParts.push(repo.description);
  }
  bodyParts.push(`\n**Repository:** ${repo.html_url}`);
  if (repo.language) {
    bodyParts.push(`**Primary language:** ${repo.language}`);
  }
  if (typeof repo.stargazers_count === "number") {
    bodyParts.push(`**Stars:** ${repo.stargazers_count}`);
  }
  if (readme) {
    bodyParts.push("\n## README\n");
    bodyParts.push(readme);
  } else {
    bodyParts.push("\n_No README.md found in the repository root._");
  }

  const skillMd = buildSkillMd({
    name,
    description,
    sourceUrl: repo.html_url,
    sourceType: "github",
    body: bodyParts.join("\n"),
    extraFrontmatter: {
      github_full_name: repo.full_name,
      github_default_branch: repo.default_branch,
    },
  });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf8");

  // Write docs/*.md files as references (capped by MAX_REFERENCES)
  if (docsFiles.length > 0) {
    const refsDir = path.join(skillDir, "references");
    fs.mkdirSync(refsDir, { recursive: true });
    for (const file of docsFiles.slice(0, MAX_REFERENCES)) {
      const safeName = sanitizeRefFilename(file.name);
      fs.writeFileSync(path.join(refsDir, safeName), file.content, "utf8");
    }
  }

  return { ok: true, skillDir, kind: "github" };
}

function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith("github.com")) {
      return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function githubApi<T>(url: string): Promise<T | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Bitterbot-SkillSeekers/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const guarded = await fetchWithSsrFGuard({
    url,
    init: { headers },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    auditContext: "skill-seekers-native:github",
  });
  try {
    if (!guarded.response.ok) {
      return null;
    }
    return (await guarded.response.json()) as T;
  } finally {
    await guarded.release();
  }
}

async function githubRaw(url: string, maxBytes: number): Promise<string | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Bitterbot-SkillSeekers/1.0",
    Accept: "application/vnd.github.v3.raw",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const guarded = await fetchWithSsrFGuard({
    url,
    init: { headers },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    auditContext: "skill-seekers-native:github-raw",
  });
  try {
    if (!guarded.response.ok) {
      return null;
    }
    const { text } = await readResponseText(guarded.response, { maxBytes });
    return text;
  } finally {
    await guarded.release();
  }
}

async function fetchGithubReadme(owner: string, repo: string): Promise<string | null> {
  // Try the standard README endpoint — returns a JSON object with download_url.
  const meta = await githubApi<{ download_url?: string | null }>(
    `${GITHUB_API_ROOT}/repos/${owner}/${repo}/readme`,
  );
  if (!meta?.download_url) {
    return null;
  }
  return githubRaw(meta.download_url, MAX_GITHUB_FILE_BYTES);
}

async function fetchGithubDocsDirectory(
  owner: string,
  repo: string,
): Promise<Array<{ name: string; content: string }>> {
  // Look at /contents/docs — many repos have this.
  const entries = await githubApi<GithubContentEntry[]>(
    `${GITHUB_API_ROOT}/repos/${owner}/${repo}/contents/docs`,
  );
  if (!Array.isArray(entries)) {
    return [];
  }
  const markdownFiles = entries.filter(
    (e) => e.type === "file" && /\.(md|mdx)$/i.test(e.name) && e.download_url,
  );
  // Grab the first MAX_REFERENCES (keep the call budget bounded)
  const selected = markdownFiles.slice(0, MAX_REFERENCES);
  const results: Array<{ name: string; content: string }> = [];
  for (const file of selected) {
    if (!file.download_url) {
      continue;
    }
    const content = await githubRaw(file.download_url, MAX_GITHUB_FILE_BYTES);
    if (content) {
      results.push({ name: file.name, content });
    }
  }
  return results;
}

// ── Output formatting ──

function prepareSkillDir(outputDir: string, name: string): string {
  const slug = slugify(name) || "skill";
  const skillDir = path.join(outputDir, slug);
  fs.mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

type SkillMdParams = {
  name: string;
  description: string;
  sourceUrl: string;
  sourceType: "docs" | "github";
  body: string;
  extraFrontmatter?: Record<string, string | number | boolean>;
};

function buildSkillMd(params: SkillMdParams): string {
  const frontmatter: string[] = [];
  frontmatter.push(`name: ${yamlEscape(params.name)}`);
  frontmatter.push(`description: ${yamlEscape(params.description)}`);
  frontmatter.push(`version: 1.0.0`);
  frontmatter.push(`source_url: ${yamlEscape(params.sourceUrl)}`);
  frontmatter.push(`source_type: ${params.sourceType}`);
  frontmatter.push(`generated_by: bitterbot-native-skill-seekers`);
  // Credit the upstream format designer even on the native path.
  frontmatter.push(
    `format_credit: "Skill Seekers format by Yusuf Karaaslan (https://github.com/yusufkaraaslan/Skill_Seekers, MIT)"`,
  );
  if (params.extraFrontmatter) {
    for (const [key, value] of Object.entries(params.extraFrontmatter)) {
      frontmatter.push(`${key}: ${yamlEscape(String(value))}`);
    }
  }
  return `---\n${frontmatter.join("\n")}\n---\n\n${params.body.trim()}\n`;
}

// ── Helpers ──

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugifyFromUrl(url: string, title?: string): string {
  if (title) {
    const slug = slugify(title);
    if (slug) {
      return slug;
    }
  }
  try {
    const u = new URL(url);
    const fromPath = u.pathname.split("/").filter(Boolean).pop();
    if (fromPath) {
      const slug = slugify(decodeURIComponent(fromPath));
      if (slug) {
        return slug;
      }
    }
    return slugify(u.hostname) || "skill";
  } catch {
    return "skill";
  }
}

function yamlEscape(value: string): string {
  if (value === "") {
    return '""';
  }
  // If the string contains anything YAML might interpret, quote it.
  if (/[:#&*!|>'"%@`\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function sanitizeRefFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "ref.md";
}
