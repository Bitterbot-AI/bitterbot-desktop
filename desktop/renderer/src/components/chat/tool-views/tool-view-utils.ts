/** Shared utilities for tool view components. */

export function safeJsonParse<T = unknown>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Extract file path from common arg shapes. */
export function extractFilePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.path === "string") return args.path;
  if (typeof args.filePath === "string") return args.filePath;
  return null;
}

/** Map file extension to language identifier for syntax highlighting. */
export function getLanguageFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    mdx: "markdown",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    xml: "xml",
    svg: "xml",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    kt: "kotlin",
    php: "php",
    lua: "lua",
    r: "r",
    dockerfile: "dockerfile",
    makefile: "makefile",
    graphql: "graphql",
    gql: "graphql",
    vue: "vue",
    svelte: "svelte",
    prisma: "prisma",
    env: "dotenv",
    ini: "ini",
    conf: "ini",
    tf: "hcl",
    proto: "protobuf",
  };
  return map[ext.toLowerCase()] ?? "text";
}

/** Extract domain from a URL string. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Try to extract from partial URL
    const match = url.match(/(?:https?:\/\/)?([^/\s:]+)/);
    return match?.[1] ?? url;
  }
}

/** Get Google favicon URL for a domain. */
export function getFaviconUrl(url: string): string {
  const domain = extractDomain(url);
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

/** Parse exit code from command output. */
export function parseExitCode(output: string): number | null {
  // Match patterns like "exit code: 0", "Exit Code: 1", "exited with code 127", "[exit_code: 0]"
  const match = output.match(
    /(?:exit[_ ]code[:\s]*|exited\s+with\s+code\s+|\[exit_code:\s*)(\d+)/i,
  );
  return match ? parseInt(match[1], 10) : null;
}

/** Detect tmux "send-keys" style non-blocking commands. */
export function isNonBlockingOutput(output: string): { sessionName: string } | null {
  // Match patterns like "Command sent to tmux session [session_name]" or
  // "Sent command to session: main" or similar non-blocking indicators
  const match = output.match(
    /(?:command sent to|sent (?:command )?to)\s+(?:tmux\s+)?session[\s:]*\[?([^\]\n]+)\]?/i,
  );
  if (match) return { sessionName: match[1].trim() };

  // Also detect "send-keys" in command args
  const keysMatch = output.match(
    /tmux\s+send-keys.*?-t\s+([^\s]+)/i,
  );
  if (keysMatch) return { sessionName: keysMatch[1].trim() };

  return null;
}

/** Classify a search result by URL/title. */
export function classifyResultType(result: { url?: string; title?: string }): string {
  const url = result.url?.toLowerCase() ?? "";
  const title = result.title?.toLowerCase() ?? "";

  if (url.includes("wikipedia.org")) return "Wiki";
  if (url.includes("github.com")) return "GitHub";
  if (url.includes("stackoverflow.com") || url.includes("stackexchange.com")) return "Q&A";
  if (url.includes("docs.") || url.includes("/docs/") || url.includes("documentation"))
    return "Docs";
  if (
    url.includes("medium.com") ||
    url.includes("dev.to") ||
    url.includes("blog") ||
    title.includes("blog")
  )
    return "Blog";
  if (url.includes("reddit.com")) return "Reddit";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "Video";
  if (url.includes("arxiv.org")) return "Paper";
  if (url.includes("npm") || url.includes("pypi")) return "Package";

  return "Website";
}

/** Extract screenshot/image data from tool output. */
export function extractScreenshot(
  output: string,
): { src: string; remaining: string } | null {
  // 1. data:image URI
  const dataUriMatch = output.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUriMatch) {
    return {
      src: dataUriMatch[0],
      remaining: output.replace(dataUriMatch[0], "[screenshot]").trim(),
    };
  }

  // 2. JSON with image_url or screenshot_base64
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed === "object" && parsed !== null) {
      const b64 = parsed.screenshot_base64 ?? parsed.screenshot ?? parsed.image_base64;
      if (typeof b64 === "string" && b64.length > 100) {
        const src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
        return { src, remaining: "" };
      }
      const imgUrl = parsed.image_url ?? parsed.imageUrl;
      if (typeof imgUrl === "string" && imgUrl.startsWith("http")) {
        return { src: imgUrl, remaining: "" };
      }
    }
  } catch {
    // not JSON
  }

  // 3. Raw base64 (heuristic: long string, valid base64 chars)
  const trimmed = output.trim();
  if (trimmed.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 300))) {
    return {
      src: `data:image/png;base64,${trimmed.replace(/\s/g, "")}`,
      remaining: "",
    };
  }

  return null;
}

/** Extract old_str / new_str from str-replace tool args. */
export function extractStrReplaceArgs(
  args: Record<string, unknown> | undefined,
): { oldStr: string; newStr: string; filePath: string | null } | null {
  if (!args) return null;

  const oldStr =
    typeof args.old_str === "string"
      ? args.old_str
      : typeof args.oldStr === "string"
        ? args.oldStr
        : typeof args.old_string === "string"
          ? args.old_string
          : null;
  const newStr =
    typeof args.new_str === "string"
      ? args.new_str
      : typeof args.newStr === "string"
        ? args.newStr
        : typeof args.new_string === "string"
          ? args.new_string
          : null;

  if (oldStr === null || newStr === null) return null;

  return {
    oldStr,
    newStr,
    filePath: extractFilePath(args),
  };
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/** Generate a simple line-level diff. */
export function generateLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = buildLCS(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && oldLines[oi] === lcs[li] && ni < newLines.length && newLines[ni] === lcs[li]) {
      diff.push({ type: "unchanged", content: oldLines[oi], oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
      oi++;
      ni++;
      li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      diff.push({ type: "removed", content: oldLines[oi], oldLineNum: oldLineNum++ });
      oi++;
    } else if (ni < newLines.length) {
      diff.push({ type: "added", content: newLines[ni], newLineNum: newLineNum++ });
      ni++;
    }
  }

  return diff;
}

function buildLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // For large diffs, fall back to simple approach
  if (m * n > 100000) {
    return simpleLCS(a, b);
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

/** Fallback LCS for large inputs — just keeps matching lines in order. */
function simpleLCS(a: string[], b: string[]): string[] {
  const result: string[] = [];
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      j++;
    } else {
      const idx = b.indexOf(a[i], j);
      if (idx !== -1) {
        result.push(a[i]);
        j = idx + 1;
      }
    }
  }
  return result;
}

/** Calculate diff statistics. */
export function calculateDiffStats(diff: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff) {
    if (line.type === "added") additions++;
    if (line.type === "removed") deletions++;
  }
  return { additions, deletions };
}

/** Format a timestamp as relative time. */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Get word/char/line counts for content. */
export function getContentStats(text: string): {
  words: number;
  chars: number;
  lines: number;
} {
  const trimmed = text.trim();
  if (!trimmed) return { words: 0, chars: 0, lines: 0 };
  return {
    words: trimmed.split(/\s+/).length,
    chars: trimmed.length,
    lines: trimmed.split("\n").length,
  };
}
