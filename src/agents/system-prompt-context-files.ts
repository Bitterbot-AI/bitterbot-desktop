/**
 * Injected workspace files (GENOME/PROTOCOLS/TOOLS/MEMORY.md) in the system
 * prompt: heading demotion and session-scoped section filtering.
 *
 * Each file renders under its own `## <path>` heading, so the file's own
 * `## Section` headings are demoted one level: they become subsections of
 * the file instead of siblings of the built-in prompt sections. Before this,
 * PROTOCOLS.md contributed a second `## Heartbeats` and a second `## Safety`
 * next to the built-in ones (the duplicate-section bug).
 *
 * A few template sections only apply to some sessions: group-chat etiquette
 * to group/channel sessions, heartbeat guidance to heartbeat runs, GitHub
 * notes when `gh` is usable. They are dropped at session scope (constant for
 * the life of a session, so the cached prefix is unaffected) and listed in
 * one pointer line so the agent knows to `read` the file for them.
 */

export type ContextSectionPolicy = {
  /** Group/channel session (session key carries `:group:` or `:channel:`). */
  group: boolean;
  /** Heartbeat run (HEARTBEAT.md is injected). */
  heartbeat: boolean;
  /** The `gh` CLI (github skill) or a github tool is available. */
  github: boolean;
};

type ConditionalSection = {
  /** Lower-cased basename of the workspace file. */
  file: string;
  /** Heading text (any level), compared case-insensitively. */
  heading: string;
  keep: (policy: ContextSectionPolicy) => boolean;
};

const CONDITIONAL_SECTIONS: ConditionalSection[] = [
  { file: "protocols.md", heading: "Group Chats", keep: (p) => p.group },
  { file: "protocols.md", heading: "Heartbeats", keep: (p) => p.heartbeat },
  { file: "tools.md", heading: "GitHub", keep: (p) => p.github },
];

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*\S)[ \t]*#*[ \t]*$/;

export function contextFileBaseName(file: { path: string }): string {
  const normalizedPath = file.path.trim().replace(/\\/g, "/");
  return (normalizedPath.split("/").pop() ?? normalizedPath).toLowerCase();
}

/** Markdown heading on this line, ignoring lines inside fenced code blocks. */
function headingOf(line: string, inFence: boolean): { level: number; text: string } | undefined {
  if (inFence) {
    return undefined;
  }
  const match = HEADING_RE.exec(line);
  if (!match) {
    return undefined;
  }
  return { level: match[1]?.length ?? 1, text: (match[2] ?? "").trim() };
}

/**
 * Demote every heading by one level (`#` -> `##`, ..., capped at `######`),
 * fence-aware so `# comment` lines inside code blocks are untouched.
 */
export function demoteHeadings(content: string): string {
  let inFence = false;
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      const heading = headingOf(line, inFence);
      if (!heading || heading.level >= 6) {
        return line;
      }
      return `#${line}`;
    })
    .join("\n");
}

/**
 * Remove the sections of `content` whose heading matches one of `headings`
 * (case-insensitive). A section runs from its heading line to the next
 * heading of the same or a higher level. Returns the pruned content and the
 * headings actually removed.
 */
export function dropSections(
  content: string,
  headings: readonly string[],
): { content: string; dropped: string[] } {
  if (headings.length === 0) {
    return { content, dropped: [] };
  }
  const wanted = new Set(headings.map((h) => h.trim().toLowerCase()));
  const out: string[] = [];
  const dropped: string[] = [];
  let inFence = false;
  let dropLevel: number | undefined;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      if (dropLevel === undefined) {
        out.push(line);
      }
      continue;
    }
    const heading = headingOf(line, inFence);
    if (heading) {
      if (dropLevel !== undefined && heading.level <= dropLevel) {
        dropLevel = undefined;
      }
      if (dropLevel === undefined && wanted.has(heading.text.toLowerCase())) {
        dropLevel = heading.level;
        dropped.push(heading.text);
        continue;
      }
    }
    if (dropLevel === undefined) {
      out.push(line);
    }
  }
  return {
    content: out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd(),
    dropped,
  };
}

export type PreparedContextFile = {
  path: string;
  content: string;
  /** Section headings omitted for this session (empty when nothing was dropped). */
  omitted: string[];
};

/**
 * Apply the session policy to one injected workspace file: drop the
 * conditional sections that do not apply, then demote the remaining headings
 * under the file's own `## <path>` heading.
 */
export function prepareContextFile(
  file: { path: string; content: string },
  policy: ContextSectionPolicy,
): PreparedContextFile {
  const base = contextFileBaseName(file);
  const headingsToDrop = CONDITIONAL_SECTIONS.filter(
    (section) => section.file === base && !section.keep(policy),
  ).map((section) => section.heading);
  const { content, dropped } = dropSections(file.content, headingsToDrop);
  return { path: file.path, content: demoteHeadings(content), omitted: dropped };
}

/**
 * One constant pointer line per session, e.g.
 * `Sections omitted for this session (read the file for them): PROTOCOLS.md: Group Chats, Heartbeats; TOOLS.md: GitHub`.
 */
export function renderOmittedSectionsLine(files: PreparedContextFile[]): string | undefined {
  const parts = files
    .filter((file) => file.omitted.length > 0)
    .map((file) => {
      const name = file.path.trim().replace(/\\/g, "/").split("/").pop() ?? file.path;
      return `${name}: ${file.omitted.join(", ")}`;
    });
  if (parts.length === 0) {
    return undefined;
  }
  return `Sections omitted for this session (read the file for them): ${parts.join("; ")}.`;
}
