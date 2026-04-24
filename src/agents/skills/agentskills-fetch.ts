/**
 * agentskills.io Import Bridge — fetch layer.
 *
 * Resolves a slug or URL to a SKILL.md body, applying a size cap and basic
 * content-type sanity checks. Does not touch disk; callers pipe the bytes to
 * agentskills-ingest for quarantine/acceptance.
 *
 * Format scope (v1): single-file SKILL.md imports. Multi-file / tarball
 * imports land as a follow-on once the registry shape stabilizes.
 */

import type { SkillsAgentskillsConfig } from "../../config/types.skills.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skills/agentskills");

const DEFAULT_REGISTRY_BASE_URL = "https://agentskills.io";
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
const FETCH_TIMEOUT_MS = 15_000;

export type AgentskillsFetchResult = {
  ok: boolean;
  /** UTF-8 SKILL.md content. */
  content?: string;
  /** URL actually fetched after slug resolution. */
  resolvedUrl?: string;
  /** Slug extracted from the input (if input was a slug). */
  slug?: string;
  error?: string;
};

function isHttpsUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve a slug-or-URL input to a concrete HTTPS URL for the SKILL.md.
 *
 * A "slug" is any input that is not itself an https URL. We treat it as
 * `<registryBaseUrl>/skills/<slug>/SKILL.md`.
 */
export function resolveAgentskillsUrl(
  input: string,
  config?: SkillsAgentskillsConfig,
): { url: string; slug?: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "empty input" };
  }

  if (isHttpsUrl(trimmed)) {
    return { url: trimmed };
  }

  if (trimmed.startsWith("http://")) {
    return { error: "plaintext HTTP is not allowed; use https://" };
  }

  // Reject anything that looks like a shell path or a relative URL.
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { error: "input must be a slug or https URL" };
  }

  const slug = normalizeSlug(trimmed);
  if (!slug) {
    return { error: "slug contains no allowed characters" };
  }

  const base = (config?.registryBaseUrl ?? DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  return { url: `${base}/skills/${slug}/SKILL.md`, slug };
}

export async function fetchAgentskillsSkill(
  input: string,
  config?: SkillsAgentskillsConfig,
): Promise<AgentskillsFetchResult> {
  const resolved = resolveAgentskillsUrl(input, config);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error };
  }

  const maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(resolved.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "text/markdown, text/plain, */*" },
    });

    if (!res.ok) {
      return {
        ok: false,
        resolvedUrl: resolved.url,
        slug: resolved.slug,
        error: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/^(text\/|application\/(json|octet-stream))/.test(contentType)) {
      log.debug(`unexpected content-type for ${resolved.url}: ${contentType}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return {
        ok: false,
        resolvedUrl: resolved.url,
        slug: resolved.slug,
        error: `skill exceeds max size (${buf.byteLength} > ${maxBytes} bytes)`,
      };
    }

    const content = buf.toString("utf-8");
    if (!content.startsWith("---")) {
      return {
        ok: false,
        resolvedUrl: resolved.url,
        slug: resolved.slug,
        error: "response is not a valid SKILL.md (missing frontmatter)",
      };
    }

    return {
      ok: true,
      content,
      resolvedUrl: resolved.url,
      slug: resolved.slug,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      resolvedUrl: resolved.url,
      slug: resolved.slug,
      error: controller.signal.aborted ? "fetch timed out" : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
}
