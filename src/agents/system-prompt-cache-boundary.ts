/**
 * Cache boundary for the system prompt (token-efficiency W4, upstream
 * OpenClaw pattern).
 *
 * The system prompt is rendered as two halves separated by one constant
 * marker line. Everything ABOVE the marker is stable for the life of a
 * session (identity, tooling names, workflow, safety, skills index, memory
 * instructions, stable workspace files ...). Everything BELOW changes
 * between turns (hormones, canonical facts, runtime line, MEMORY.md ...).
 *
 * Anthropic's prompt cache is a prefix match over tools -> system -> messages,
 * so the payload wrapper (`pi-embedded-runner/anthropic-payload-cache.ts`)
 * splits `system` at the marker into a cached block and an unmarked block.
 * For every other provider the marker stays in the prompt as an HTML
 * comment: constant bytes, no instruction content, ~8 tokens.
 *
 * The stable half is byte-normalized here (CRLF -> LF, trailing whitespace
 * trimmed per line, 3+ blank lines collapsed) so that cosmetic differences
 * between renders can never bust the cache.
 */

import crypto from "node:crypto";

export const CACHE_BOUNDARY_MARKER = "<!-- BITTERBOT_CACHE_BOUNDARY -->";

export function normalizeStablePromptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeVolatilePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * Join the two halves. The historical builder dropped empty strings
 * (`lines.filter(Boolean)`), so blank spacer lines never reach the prompt;
 * that behaviour is preserved for both halves.
 */
export function assembleSystemPromptWithBoundary(params: {
  stable: string[];
  volatile: string[];
}): string {
  const stable = normalizeStablePromptText(params.stable.filter(Boolean).join("\n"));
  const volatileText = normalizeVolatilePromptText(params.volatile.filter(Boolean).join("\n"));
  if (!volatileText) {
    return stable;
  }
  return `${stable}\n${CACHE_BOUNDARY_MARKER}\n${volatileText}`;
}

export type SystemPromptHalves = {
  /** Text above the marker (the marker line itself excluded). */
  stable: string;
  /** Text below the marker; undefined when no marker is present. */
  volatile?: string;
  found: boolean;
};

/** Split a rendered system prompt at the first marker occurrence. */
export function splitSystemPromptAtBoundary(text: string): SystemPromptHalves {
  const index = text.indexOf(CACHE_BOUNDARY_MARKER);
  if (index === -1) {
    return { stable: text, found: false };
  }
  const stable = text.slice(0, index).replace(/\n+$/g, "");
  const volatileText = text
    .slice(index + CACHE_BOUNDARY_MARKER.length)
    .replace(/^\n+/g, "")
    .replace(/\n+$/g, "");
  return { stable, volatile: volatileText, found: true };
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Separate digests for the two halves, so an operator can prove the stable
 * half is byte-identical across turns while the volatile half moves.
 */
export function digestSystemPromptHalves(text: string): {
  stableDigest: string;
  volatileDigest?: string;
  boundaryFound: boolean;
} {
  const halves = splitSystemPromptAtBoundary(text);
  return {
    stableDigest: sha256Hex(halves.stable),
    volatileDigest: halves.volatile === undefined ? undefined : sha256Hex(halves.volatile),
    boundaryFound: halves.found,
  };
}

/**
 * Digest of the tool definitions in the byte order the Anthropic payload
 * wrapper sends them (sorted by name). Only the fields that reach the wire
 * participate: name, description, parameters.
 */
export function digestToolDefinitions(
  tools: ReadonlyArray<{ name: string; description?: unknown; parameters?: unknown }> | undefined,
): string | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  const sorted = tools
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters ?? null,
    }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted));
}
