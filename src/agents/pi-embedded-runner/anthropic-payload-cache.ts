/**
 * Anthropic prompt-cache layout, applied to the request payload through
 * pi-ai's `onPayload` hook (same pattern as the OpenAI Responses `store`
 * wrapper in extra-params.ts).
 *
 * Vendored pi-ai 0.52.12 places exactly two `cache_control` markers: the
 * single system block and the last user message. Nothing on tools, and tools
 * in discovery order. This wrapper reshapes the payload so that:
 *
 *   tools   -> sorted by name, marker on the LAST NON-DEFERRED definition
 *              (a `defer_loading: true` tool cannot carry cache_control)
 *   system  -> [stable block (marker)] only
 *   messages-> pi-ai's last-user marker stays; the volatile half of the
 *              prompt is appended AFTER it as an unmarked text block on the
 *              last user message (`<runtime-state>` tail)
 *
 * Why the tail: the volatile half (hormones, runtime line, scratch notes)
 * differs between turns. Rendered as a second system block it sat BEFORE the
 * conversation, so every turn re-wrote the volatile text plus the entire
 * history (measured 2026-09-20: ~8.5k cache-write tokens per turn, growing
 * with history). Placed after the previous turn's marker it is plain input
 * (~0.5-4k tokens) and the history prefix hits the cache untouched. This is
 * the "shared prefix, varying suffix" placement from Anthropic's caching
 * guide; the next turn's transcript does not contain the tail, which is fine
 * because the entry written at the marker ends before it.
 *
 * Anthropic rules honoured: prefix match over tools -> system -> messages,
 * tiered (a system change leaves the tools entry intact), max 4 markers,
 * 1h entries must precede 5m entries (every marker we place carries the
 * same TTL as pi-ai's, so ordering is trivially satisfied).
 *
 * Guard: when the system prompt carries no boundary marker, only the tool
 * sort + tool marker are applied. Idempotent: a second application is a
 * no-op (the boundary line is consumed by the first).
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CACHE_BOUNDARY_MARKER,
  splitSystemPromptAtBoundary,
} from "../system-prompt-cache-boundary.js";

const log = createSubsystemLogger("anthropic-cache-layout");

export const ANTHROPIC_MAX_CACHE_MARKERS = 4;

export type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };
export type AnthropicCacheRetention = "none" | "short" | "long";

type TextBlock = { type: string; text?: string; cache_control?: AnthropicCacheControl };
type ToolDef = {
  name?: unknown;
  type?: unknown;
  defer_loading?: unknown;
  cache_control?: AnthropicCacheControl;
} & Record<string, unknown>;
type MessageParam = { role?: string; content?: unknown };

export type AnthropicCacheLayoutResult = {
  boundaryFound: boolean;
  markerCount: number;
  stableSystemChars: number;
  volatileSystemChars: number;
  /**
   * Where the volatile half landed: user-message tail, a `role: "system"`
   * message after the last user message, the system-array fallback (no user
   * message to attach to), or nothing to place.
   */
  volatilePlacement: "user-tail" | "system-message" | "system" | "none";
  toolCount: number;
  /** Tools sent with `defer_loading: true` (native tool search). */
  deferredToolCount: number;
};

export type AnthropicCacheLayoutOptions = {
  /**
   * `user-tail` (default): unmarked text block on the last user message.
   * `system-message`: `{ role: "system", content }` appended after the last
   * user message (Opus 4.8+/Fable; the caller handles the 400 fallback).
   */
  volatilePlacement?: "user-tail" | "system-message";
};

export const RUNTIME_STATE_OPEN = "<runtime-state>";
export const RUNTIME_STATE_CLOSE = "</runtime-state>";

/**
 * Append the volatile text as an unmarked block after the last user
 * message's existing content (tool_result blocks included). Returns false
 * when there is no user message to attach to.
 */
function placeVolatileTail(messages: unknown, volatileText: string): boolean {
  if (!Array.isArray(messages) || volatileText.length === 0) {
    return false;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageParam | undefined;
    if (!message || message.role !== "user") {
      continue;
    }
    const content: TextBlock[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as TextBlock[])
          : [];
    // Idempotence: never stack a second tail on the same message.
    if (
      content.some(
        (block) =>
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.startsWith(RUNTIME_STATE_OPEN),
      )
    ) {
      return true;
    }
    content.push({
      type: "text",
      text: `${RUNTIME_STATE_OPEN}\n${volatileText}\n${RUNTIME_STATE_CLOSE}`,
    });
    message.content = content;
    return true;
  }
  return false;
}

/**
 * Append the volatile text as a mid-conversation system message. Anthropic
 * requires it to immediately follow a user message (tool_result messages
 * count) and to be last or followed by an assistant turn; our last message
 * is always the user turn, so it goes at the very end. Returns false when
 * the last message is not a user message (caller falls back to user-tail).
 */
function placeVolatileSystemMessage(messages: unknown, volatileText: string): boolean {
  if (!Array.isArray(messages) || volatileText.length === 0) {
    return false;
  }
  const last = messages[messages.length - 1] as MessageParam | undefined;
  if (!last) {
    return false;
  }
  if (last.role === "system") {
    // Idempotence: a layout already placed the tail.
    return true;
  }
  if (last.role !== "user") {
    return false;
  }
  messages.push({
    role: "system",
    content: [
      { type: "text", text: `${RUNTIME_STATE_OPEN}\n${volatileText}\n${RUNTIME_STATE_CLOSE}` },
    ],
  });
  return true;
}

/** Mirror pi-ai's getCacheControl: 1h only for `long` against api.anthropic.com. */
export function resolveAnthropicCacheControl(params: {
  retention: AnthropicCacheRetention;
  baseUrl?: unknown;
}): AnthropicCacheControl | undefined {
  if (params.retention === "none") {
    return undefined;
  }
  const baseUrl = typeof params.baseUrl === "string" ? params.baseUrl : "";
  const ttl =
    params.retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

function toolName(tool: ToolDef): string {
  return typeof tool.name === "string" ? tool.name : "";
}

function layoutTools(tools: unknown, cacheControl: AnthropicCacheControl | undefined): ToolDef[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const defs = tools.filter((tool): tool is ToolDef => !!tool && typeof tool === "object");
  // Stable byte order: code-unit comparison, not locale-aware.
  defs.sort((a, b) => {
    const an = toolName(a);
    const bn = toolName(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const def of defs) {
    delete def.cache_control;
  }
  if (cacheControl) {
    const target = pickToolMarkerTarget(defs);
    if (target) {
      target.cache_control = { ...cacheControl };
    }
  }
  return defs;
}

/**
 * The marker goes on the last NON-deferred definition: a deferred tool cannot
 * carry cache_control (400), and deferred tools are excluded from the rendered
 * prefix anyway, so the marker still covers every loaded definition. A custom
 * tool is preferred over a server-tool entry (`type` field) when both qualify.
 */
function pickToolMarkerTarget(defs: ToolDef[]): ToolDef | undefined {
  let fallback: ToolDef | undefined;
  for (let i = defs.length - 1; i >= 0; i--) {
    const def = defs[i];
    if (!def || def.defer_loading === true) {
      continue;
    }
    if (def.type === undefined) {
      return def;
    }
    fallback ??= def;
  }
  return fallback;
}

function layoutSystem(
  system: unknown,
  cacheControl: AnthropicCacheControl | undefined,
): {
  blocks: TextBlock[];
  boundaryFound: boolean;
  stableIndex: number;
  stableChars: number;
  volatileChars: number;
  volatileText: string;
} {
  const blocks: TextBlock[] =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : Array.isArray(system)
        ? system.filter((b): b is TextBlock => !!b && typeof b === "object")
        : [];
  const index = blocks.findIndex(
    (block) => typeof block.text === "string" && block.text.includes(CACHE_BOUNDARY_MARKER),
  );
  if (index === -1) {
    return {
      blocks,
      boundaryFound: false,
      stableIndex: -1,
      stableChars: 0,
      volatileChars: 0,
      volatileText: "",
    };
  }
  const halves = splitSystemPromptAtBoundary(blocks[index]?.text ?? "");
  const stable: TextBlock = { type: "text", text: halves.stable };
  if (cacheControl) {
    stable.cache_control = { ...cacheControl };
  }
  const volatileText = halves.volatile ?? "";
  const replacement: TextBlock[] = [stable];
  const after = blocks.slice(index + 1).map((block) => {
    // Anything after the stable block is volatile by construction: no marker.
    const { cache_control: _dropped, ...rest } = block;
    return rest;
  });
  return {
    blocks: [...blocks.slice(0, index), ...replacement, ...after],
    boundaryFound: true,
    stableIndex: index,
    stableChars: halves.stable.length,
    volatileChars: volatileText.length,
    volatileText,
  };
}

function countMessageMarkers(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let count = 0;
  for (const message of messages as MessageParam[]) {
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content as TextBlock[]) {
      if (block && typeof block === "object" && block.cache_control) {
        count += 1;
      }
    }
  }
  return count;
}

function countMarkers(tools: ToolDef[], system: TextBlock[], messages: unknown): number {
  return (
    tools.filter((t) => t.cache_control).length +
    system.filter((b) => b.cache_control).length +
    countMessageMarkers(messages)
  );
}

/**
 * Mutate an Anthropic Messages payload in place. Returns a summary for
 * logging/tests, or undefined when the payload is not an object.
 */
export function applyAnthropicCacheLayout(
  payload: unknown,
  cacheControl: AnthropicCacheControl | undefined,
  options?: AnthropicCacheLayoutOptions,
): AnthropicCacheLayoutResult | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const params = payload as { tools?: unknown; system?: unknown; messages?: unknown };
  const tools = layoutTools(params.tools, cacheControl);
  if (Array.isArray(params.tools)) {
    params.tools = tools;
  }
  const system = layoutSystem(params.system, cacheControl);
  let volatilePlacement: AnthropicCacheLayoutResult["volatilePlacement"] = "none";
  if (system.boundaryFound) {
    if (system.volatileText.length > 0) {
      if (
        options?.volatilePlacement === "system-message" &&
        placeVolatileSystemMessage(params.messages, system.volatileText)
      ) {
        volatilePlacement = "system-message";
      } else if (placeVolatileTail(params.messages, system.volatileText)) {
        volatilePlacement = "user-tail";
      } else {
        // No user message to attach to (should not happen for a real turn):
        // keep the old second-system-block shape rather than drop state.
        system.blocks.splice(system.stableIndex + 1, 0, {
          type: "text",
          text: system.volatileText,
        });
        volatilePlacement = "system";
      }
    }
    params.system = system.blocks;
  }

  // Marker budget: tools(1) + stable system(1) + optional OAuth identity
  // block(1) + pi-ai last-user(1) = 4. Shed from the least valuable end if a
  // future pi-ai adds more: non-stable system blocks first, then the tools.
  let markerCount = countMarkers(tools, system.blocks, params.messages);
  for (let i = 0; i < system.blocks.length && markerCount > ANTHROPIC_MAX_CACHE_MARKERS; i++) {
    if (i !== system.stableIndex && system.blocks[i]?.cache_control) {
      delete system.blocks[i]?.cache_control;
      markerCount -= 1;
    }
  }
  if (markerCount > ANTHROPIC_MAX_CACHE_MARKERS) {
    const marked = tools.find((t) => t.cache_control);
    if (marked) {
      delete marked.cache_control;
      markerCount -= 1;
    }
  }

  return {
    boundaryFound: system.boundaryFound,
    markerCount,
    stableSystemChars: system.stableChars,
    volatileSystemChars: system.volatileChars,
    volatilePlacement,
    toolCount: tools.length,
    deferredToolCount: tools.filter((t) => t.defer_loading === true).length,
  };
}

/**
 * streamFn wrapper: applies the layout for Anthropic Messages requests only
 * (`model.api === "anthropic-messages"`), chaining any existing onPayload.
 */
export function createAnthropicCacheLayoutWrapper(
  baseStreamFn: StreamFn | undefined,
  retention: AnthropicCacheRetention,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model?.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }
    const cacheControl = resolveAnthropicCacheControl({ retention, baseUrl: model.baseUrl });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        try {
          const result = applyAnthropicCacheLayout(payload, cacheControl);
          if (result) {
            log.debug(
              `cache layout: boundary=${result.boundaryFound} markers=${result.markerCount} tools=${result.toolCount} stable=${result.stableSystemChars}c volatile=${result.volatileSystemChars}c@${result.volatilePlacement} ttl=${cacheControl?.ttl ?? (cacheControl ? "5m" : "none")}`,
            );
          }
        } catch (err) {
          log.warn(`cache layout skipped: ${String(err)}`);
        }
        originalOnPayload?.(payload);
      },
    });
  };
}
