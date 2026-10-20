/**
 * Derive a skill's display name from crystal text. Whole-document skill
 * crystals begin with YAML frontmatter (`---\nname: ...`), so "first line"
 * is `---` for most of them — the defect the 2026-09-03 adversarial pass
 * caught in both the validation join and the registry royalty join.
 */
export function skillNameFromText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    const frontmatter = end > 0 ? trimmed.slice(3, end) : trimmed.slice(3);
    const m = /^\s*name:\s*["']?([^"'\n]+?)["']?\s*$/im.exec(frontmatter);
    if (m?.[1]) {
      return m[1].trim().slice(0, 100);
    }
    // No name in frontmatter: first non-empty body line after it.
    const body = end > 0 ? trimmed.slice(end + 4) : "";
    const first = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return (first ?? "").replace(/^#+\s*/, "").slice(0, 100);
  }
  return (trimmed.split("\n")[0] ?? "")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 100);
}
