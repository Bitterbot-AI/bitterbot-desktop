#!/usr/bin/env node
/**
 * docs-link-audit.mjs
 *
 * Walks every tracked docs/**\/*.md(x) plus README.md, extracts every
 * link (markdown, reference-style, JSX href= / src=, and autolinks),
 * and validates it against:
 *
 *   - The actual filesystem (with Mintlify path resolution: an absolute
 *     `/foo/bar` link maps to `docs/foo/bar.md`, `docs/foo/bar.mdx`,
 *     `docs/foo/bar/index.md`, or `docs/foo/bar/index.mdx`).
 *   - The `redirects` array in docs/docs.json — redirect sources count
 *     as valid link targets, since Mintlify resolves them at runtime.
 *   - Same-file anchors (links like `#scientific-basis`) by computing
 *     the Mintlify slug for every heading in the source file.
 *
 * External links (http://, https://) are NOT fetched by default. Pass
 * `--check-external` to enable network checks (CI should leave this off).
 *
 * Exit code: 0 on success, 1 on any broken link.
 *
 * Run via:  pnpm docs:check-links   (or)   node scripts/docs-link-audit.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const DOCS_JSON = path.join(DOCS_ROOT, "docs.json");
const IGNORE_FILE = path.join(path.dirname(__filename), "docs-link-audit.ignore.txt");

// ─── CLI ────────────────────────────────────────────────────────────

const argv = new Set(process.argv.slice(2));
const CHECK_EXTERNAL = argv.has("--check-external");
const VERBOSE = argv.has("--verbose") || argv.has("-v");

// ─── File discovery ─────────────────────────────────────────────────

function listTrackedDocs() {
  // Use git ls-files so we honor .gitignore and don't pick up build
  // artifacts. README.md is the only top-level doc we lint.
  const out = execSync(`git ls-files 'docs/**/*.md' 'docs/**/*.mdx' 'README.md'`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/**
 * Set of every git-tracked path in the repo (POSIX-style, repo-relative).
 * Used by the resolvers below so a link can only resolve to a file that
 * exists in the committed tree. Without this gate, files under gitignored
 * directories (e.g. `research/` plan docs) would resolve locally but break
 * on a clean CI checkout — exactly the failure that produced this gate.
 */
function loadTrackedFiles() {
  const out = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" });
  const set = new Set();
  for (const line of out.split("\n")) {
    if (line) set.add(line);
  }
  return set;
}

/**
 * Resolve an absolute filesystem path to its repo-relative POSIX form for
 * membership testing against `loadTrackedFiles()`.
 */
function repoRelative(abs) {
  let rel = path.relative(REPO_ROOT, abs);
  // Normalize for Windows checkouts.
  if (path.sep !== "/") rel = rel.split(path.sep).join("/");
  return rel;
}

// ─── Mintlify path resolution ───────────────────────────────────────

/**
 * Load docs.json redirects. Returns a matcher object with:
 *   - `exact: Set<string>` of plain source paths
 *   - `wildcards: Array<RegExp>` for sources like `/foo/:slug*` (Mintlify's
 *     catch-all parameter, Next.js routing syntax)
 *   - `match(path): boolean`
 */
function loadRedirects() {
  const exact = new Set();
  /** @type {Array<RegExp>} */
  const wildcards = [];
  try {
    const cfg = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
    const redirects = Array.isArray(cfg.redirects) ? cfg.redirects : [];
    for (const r of redirects) {
      if (typeof r?.source !== "string") continue;
      const src = normalizeAbsolutePath(r.source);
      if (src.includes(":")) {
        // Convert Next.js param syntax to a regex:
        //   :slug*  → .*   (catch-all, zero or more segments)
        //   :slug+  → .+   (one or more)
        //   :slug   → [^/]+ (single segment)
        const pattern = src
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)\*/g, "(?:/.*)?")
          .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)\+/g, "/.+")
          .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "[^/]+");
        wildcards.push(new RegExp(`^${pattern}$`));
      } else {
        exact.add(src);
      }
    }
  } catch (err) {
    if (VERBOSE) console.warn(`[link-audit] failed to read docs.json: ${String(err)}`);
  }
  return {
    exact,
    wildcards,
    size: exact.size + wildcards.length,
    match(p) {
      const norm = normalizeAbsolutePath(p);
      if (this.exact.has(norm)) return true;
      for (const re of this.wildcards) {
        if (re.test(norm)) return true;
      }
      return false;
    },
  };
}

function normalizeAbsolutePath(p) {
  // Strip trailing slash (except for "/") so "/foo/" and "/foo" hash equal.
  let out = p.startsWith("/") ? p : `/${p}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Resolve a Mintlify-style absolute path (`/foo/bar`) to a concrete
 * file under `docs/`. A candidate is only accepted if it exists on
 * disk AND is tracked by git (via the `tracked` set) — otherwise the
 * link would only resolve in a dev checkout that happens to have
 * gitignored content present, and would break in CI.
 */
function resolveAbsoluteDocPath(p, tracked) {
  const norm = normalizeAbsolutePath(p);
  // Strip leading slash; if the path was just "/", treat as /index.
  const rel = norm === "/" ? "index" : norm.slice(1);
  const candidates = [
    path.join(DOCS_ROOT, `${rel}.md`),
    path.join(DOCS_ROOT, `${rel}.mdx`),
    path.join(DOCS_ROOT, rel, "index.md"),
    path.join(DOCS_ROOT, rel, "index.mdx"),
    // Asset references — Mintlify serves docs/ root + docs/public/ at /.
    path.join(DOCS_ROOT, rel),
    path.join(DOCS_ROOT, "public", rel),
  ];
  for (const c of candidates) {
    if (existsSync(c) && tracked.has(repoRelative(c))) return c;
  }
  return null;
}

/**
 * Resolve a relative path (e.g. `../bar/baz.md` or `./foo`) from a source file.
 * Same git-tracked gate as `resolveAbsoluteDocPath` for file targets. A trailing
 * `/` (or any directory target) is accepted if at least one git-tracked file
 * lives inside — this mirrors how README-style links to `docs/start/` work on
 * the GitHub repo view, which renders a tree listing.
 */
function resolveRelativeDocPath(rel, fromFile, tracked) {
  const baseDir = path.dirname(path.join(REPO_ROOT, fromFile));
  const tryPaths = [
    path.resolve(baseDir, rel),
    path.resolve(baseDir, `${rel}.md`),
    path.resolve(baseDir, `${rel}.mdx`),
    path.resolve(baseDir, rel, "index.md"),
    path.resolve(baseDir, rel, "index.mdx"),
  ];
  for (const c of tryPaths) {
    if (existsSync(c) && tracked.has(repoRelative(c))) return c;
  }
  // Directory target with tracked contents (GitHub tree-listing view).
  const dirCandidate = path.resolve(baseDir, rel);
  if (existsSync(dirCandidate)) {
    const prefix = `${repoRelative(dirCandidate)}/`;
    for (const t of tracked) {
      if (t.startsWith(prefix)) return dirCandidate;
    }
  }
  return null;
}

// ─── Slug + heading extraction ──────────────────────────────────────

/**
 * Mintlify slugify — mirrors `github-slugger` semantics, which Mintlify
 * uses under the hood. Critical detail: non-alphanumeric characters are
 * REPLACED with `-`, not stripped. So `agents.defaults.sandbox` becomes
 * `agents-defaults-sandbox`, not `agentsdefaultssandbox`. Consecutive
 * dashes are collapsed, leading/trailing dashes trimmed.
 */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractHeadings(text) {
  const slugs = new Set();
  const counts = new Map();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const raw = m[1].trim();
    let slug = slugify(raw);
    // Mintlify (like GitHub) disambiguates duplicate slugs with -1, -2, ...
    if (counts.has(slug)) {
      const n = counts.get(slug) + 1;
      counts.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      counts.set(slug, 0);
    }
    slugs.add(slug);
  }
  return slugs;
}

// ─── Link extraction ────────────────────────────────────────────────

/**
 * Extract every link from a doc body. Returns an array of:
 *   { url, line, kind: 'md' | 'jsx' | 'autolink' | 'ref' }
 *
 * Stripped first:
 *   - fenced code blocks (``` … ```)
 *   - inline code (`…`)
 * so we don't treat sample URLs in code blocks as links to audit.
 */
function extractLinks(text) {
  const lines = text.split("\n");
  const links = [];

  // First strip fenced blocks line-by-line so we can still report line
  // numbers correctly for the remaining content.
  const stripped = [];
  let inFence = false;
  let fenceTag = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceTag = fenceMatch[2];
        stripped.push("");
        continue;
      }
      if (line.trimStart().startsWith(fenceTag)) {
        inFence = false;
        stripped.push("");
        continue;
      }
    }
    if (inFence) {
      stripped.push("");
      continue;
    }
    // Strip inline code.
    stripped.push(line.replace(/`[^`\n]*`/g, ""));
  }

  // Reference-style link definitions: [ref]: url
  const refDefs = new Map();
  for (let i = 0; i < stripped.length; i++) {
    const m = stripped[i].match(/^\s*\[([^\]]+)\]:\s*(\S+)/);
    if (m) refDefs.set(m[1].toLowerCase(), { url: m[2], line: i + 1 });
  }

  // Now scan each line for link forms.
  const mdInline = /\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const mdRef = /\[(?:[^\]\\]|\\.)*\]\[([^\]]+)\]/g;
  const jsxHref = /\b(?:href|src)\s*=\s*"([^"]+)"/g;
  const jsxHrefBrace = /\b(?:href|src)\s*=\s*\{\s*['"]([^'"]+)['"]\s*\}/g;
  const autolink = /<((?:https?|mailto):[^>\s]+)>/g;

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    for (const m of line.matchAll(mdInline)) {
      links.push({ url: m[1], line: i + 1, kind: "md" });
    }
    for (const m of line.matchAll(mdRef)) {
      const ref = m[1].toLowerCase();
      const target = refDefs.get(ref);
      if (target) {
        links.push({ url: target.url, line: i + 1, kind: "ref" });
      }
      // If the ref doesn't exist, that's a different error class
      // (markdownlint catches it). We don't double-report.
    }
    for (const m of line.matchAll(jsxHref)) {
      links.push({ url: m[1], line: i + 1, kind: "jsx" });
    }
    for (const m of line.matchAll(jsxHrefBrace)) {
      links.push({ url: m[1], line: i + 1, kind: "jsx" });
    }
    for (const m of line.matchAll(autolink)) {
      links.push({ url: m[1], line: i + 1, kind: "autolink" });
    }
  }

  return links;
}

// ─── Classification ─────────────────────────────────────────────────

function classifyLink(url) {
  if (url.startsWith("http://") || url.startsWith("https://")) return "external";
  if (url.startsWith("mailto:") || url.startsWith("tel:")) return "skip";
  if (url.startsWith("//")) return "external"; // protocol-relative
  if (url.startsWith("data:")) return "skip";
  if (url.startsWith("#")) return "anchor-local";
  if (url.startsWith("/")) return "absolute";
  return "relative";
}

// ─── Validation ─────────────────────────────────────────────────────

async function checkExternal(url) {
  try {
    // HEAD with redirect-follow; fall back to GET if HEAD is 405.
    let resp = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(url, { method: "GET", redirect: "follow" });
    }
    return resp.ok || resp.status === 429 || resp.status === 403 ? null : `HTTP ${resp.status}`;
    // 429 / 403 are common false-positives for bot protection.
  } catch (err) {
    return err?.message || String(err);
  }
}

function splitFragment(url) {
  const i = url.indexOf("#");
  if (i < 0) return { path: url, fragment: null };
  return { path: url.slice(0, i), fragment: url.slice(i + 1) };
}

async function validateLink(link, fromFile, ctx) {
  const kind = classifyLink(link.url);

  if (kind === "skip") return null;

  if (kind === "anchor-local") {
    const slug = link.url.slice(1);
    if (slug && !ctx.headings.has(slug)) {
      return `missing anchor #${slug} in current file`;
    }
    return null;
  }

  if (kind === "external") {
    if (!CHECK_EXTERNAL) return null;
    const err = await checkExternal(link.url);
    return err ? `external ${err}` : null;
  }

  const { path: urlPath, fragment } = splitFragment(link.url);

  if (kind === "absolute") {
    if (ctx.redirects.match(urlPath)) return null;
    const resolved = resolveAbsoluteDocPath(urlPath, ctx.tracked);
    if (!resolved) return `target not found: ${urlPath}`;
    if (fragment) {
      // Cross-file anchor: best-effort check using the resolved file's
      // headings. Cheap because we only re-parse on demand.
      const target = readFileSync(resolved, "utf8");
      const slugs = extractHeadings(target);
      if (!slugs.has(fragment)) {
        return `missing anchor #${fragment} in ${path.relative(REPO_ROOT, resolved)}`;
      }
    }
    return null;
  }

  if (kind === "relative") {
    const resolved = resolveRelativeDocPath(urlPath, fromFile, ctx.tracked);
    if (!resolved) return `relative target not found: ${urlPath}`;
    if (fragment) {
      const target = readFileSync(resolved, "utf8");
      const slugs = extractHeadings(target);
      if (!slugs.has(fragment)) {
        return `missing anchor #${fragment} in ${path.relative(REPO_ROOT, resolved)}`;
      }
    }
    return null;
  }

  return null;
}

// ─── Ignore list ────────────────────────────────────────────────────

/**
 * Read the docs-link-audit.ignore.txt file. Format: one entry per line,
 * `file:url` (e.g. `docs/cli/index.md:/nodes`). Lines starting with `#`
 * or blank are comments. Wildcards aren't supported — every entry must
 * be exact, so removing the broken link from a doc forces the ignore
 * line to be removed too. Prevents stale entries.
 *
 * Returns: Set<string> of "file:url" tokens.
 */
function loadIgnoreList() {
  const set = new Set();
  if (!existsSync(IGNORE_FILE)) return set;
  const text = readFileSync(IGNORE_FILE, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    set.add(line);
  }
  return set;
}

function ignoreKey(file, url) {
  return `${file}:${url}`;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const docs = listTrackedDocs();
  const tracked = loadTrackedFiles();
  const redirects = loadRedirects();
  const ignore = loadIgnoreList();
  if (VERBOSE) {
    console.log(
      `Auditing ${docs.length} doc files (${tracked.size} tracked total). ` +
        `Redirects: ${redirects.size}. Ignore entries: ${ignore.size}.`,
    );
    console.log(`External link checks: ${CHECK_EXTERNAL ? "ON" : "off (use --check-external)"}.`);
  }

  let total = 0;
  let broken = 0;
  let ignored = 0;
  /** @type {Array<{file: string; line: number; url: string; err: string}>} */
  const failures = [];
  /** @type {Set<string>} */
  const ignoreHits = new Set();

  for (const docFile of docs) {
    const abs = path.join(REPO_ROOT, docFile);
    const text = readFileSync(abs, "utf8");
    const links = extractLinks(text);
    const headings = extractHeadings(text);
    const ctx = { redirects, headings, tracked };

    const externals = [];
    for (const link of links) {
      total++;
      if (classifyLink(link.url) === "external") {
        externals.push({ link, p: validateLink(link, docFile, ctx) });
      } else {
        const err = await validateLink(link, docFile, ctx);
        if (err) {
          const key = ignoreKey(docFile, link.url);
          if (ignore.has(key)) {
            ignored++;
            ignoreHits.add(key);
          } else {
            broken++;
            failures.push({ file: docFile, line: link.line, url: link.url, err });
          }
        }
      }
    }
    for (const { link, p } of externals) {
      const err = await p;
      if (err) {
        const key = ignoreKey(docFile, link.url);
        if (ignore.has(key)) {
          ignored++;
          ignoreHits.add(key);
        } else {
          broken++;
          failures.push({ file: docFile, line: link.line, url: link.url, err });
        }
      }
    }
  }

  // Stale ignore entries (in the file but no longer broken) are an
  // error too — ratchet works in both directions so the ignore file
  // stays accurate.
  const stale = [...ignore].filter((k) => !ignoreHits.has(k));

  if (broken === 0 && stale.length === 0) {
    console.log(
      `[link-audit] OK — ${total} link(s) checked across ${docs.length} doc file(s). ` +
        `Ignored: ${ignored}.`,
    );
    process.exit(0);
  }

  console.log("");
  if (broken > 0) {
    console.log(`[link-audit] FAIL — ${broken} broken link(s) out of ${total}:`);
    for (const f of failures) {
      console.log(`  ${f.file}:${f.line}  ${f.url}  →  ${f.err}`);
    }
  }
  if (stale.length > 0) {
    console.log("");
    console.log(
      `[link-audit] FAIL — ${stale.length} stale ignore entr${stale.length === 1 ? "y" : "ies"} ` +
        `(link is no longer broken; remove from ${path.relative(REPO_ROOT, IGNORE_FILE)}):`,
    );
    for (const s of stale) console.log(`  ${String(s)}`);
  }
  console.log("");
  process.exit(1);
}

main().catch((err) => {
  console.error(`[link-audit] crash: ${err?.stack || err}`);
  process.exit(2);
});
