import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { MemorySearchResult } from "../../memory/types.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

// PLAN-33 Phase 1: canonical facts ledger operations.
const MemoryPinSchema = Type.Object({
  action: Type.Union([
    Type.Literal("pin"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("retire"),
  ]),
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  statement: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
});

// PLAN-24 HORMA Phase 0: resolve an evidence_ref (surfaced on memory_search
// results as `evidenceRefs`) back to verbatim raw source.
const MemoryExpandSchema = Type.Object({
  kind: Type.Union([Type.Literal("session"), Type.Literal("journal")]),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
  runId: Type.Optional(Type.String()),
  seq: Type.Optional(Type.Number()),
  window: Type.Optional(Type.Number()),
});

function resolveMemoryToolContext(options: { config?: BitterbotConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export function createMemorySearchTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. Exact ground-truth hits from the canonical ledger (repo names, endpoints, identities, standing decisions) are surfaced first under `canonical` — trust those over the fuzzy `results` snippets.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        const results = decorated;
        const canonical = resolveCanonicalLookup(cfg, manager, query ?? "");
        return jsonResult({
          // PLAN-33 Phase 4: ledger-first — authoritative exact-key hits before
          // the fuzzy semantic results. Omitted entirely when there is no match.
          ...(canonical.length > 0 ? { canonical } : {}),
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

export function createMemoryExpandTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  if (cfg.memory?.provenance?.enabled === false) {
    return null;
  }
  return {
    label: "Memory Expand",
    name: "memory_expand",
    description:
      "Drill from a recalled fact back to its verbatim raw source. Pass an evidenceRefs entry from a memory_search result (kind+path+line for session refs, or kind+runId+seq for journal refs) to recover the exact original text — use when a paraphrased memory is load-bearing or you need to verify it.",
    parameters: MemoryExpandSchema,
    execute: async (_toolCallId, params) => {
      const kind = readStringParam(params, "kind", { required: true });
      const window = readNumberParam(params, "window", { integer: true });
      let ref: import("../../memory/session-extractor.js").EvidenceRef;
      if (kind === "session") {
        const refPath = readStringParam(params, "path", { required: true });
        const line = readNumberParam(params, "line", { integer: true });
        if (!refPath || line == null) {
          return jsonResult({ found: false, error: "session ref requires path and line" });
        }
        ref = { kind: "session", path: refPath, line };
      } else {
        const runId = readStringParam(params, "runId", { required: true });
        const seq = readNumberParam(params, "seq", { integer: true });
        if (!runId || seq == null) {
          return jsonResult({ found: false, error: "journal ref requires runId and seq" });
        }
        ref = { kind: "journal", runId, seq };
      }
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager?.expandEvidence) {
        return jsonResult({ found: false, disabled: true, error });
      }
      try {
        const expanded = await manager.expandEvidence(ref, window ?? undefined);
        return jsonResult(expanded);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ found: false, error: message });
      }
    },
  };
}

/**
 * PLAN-33 Phase 1: the canonical facts ledger tool. Pin exact key-value
 * ground truth ("the repo is X") so it is injected into EVERY future system
 * prompt unconditionally — no similarity retrieval, no cooldown, no decay
 * out of the prompt. Re-pinning the same value strengthens; a new value
 * supersedes (bitemporal — the old belief keeps its validity window).
 */
export function createMemoryPinTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  if (cfg.memory?.canonicalLedger?.enabled === false) {
    return null;
  }
  return {
    label: "Memory Pin",
    name: "memory_pin",
    description:
      "Pin a canonical fact (exact key-value ground truth: repo names, endpoints, identities, standing decisions) into the always-injected ledger. Use when the user states a durable fact, corrects you on one, or says 'remember this'. Actions: pin {key, value, statement?, category?} (add/strengthen/supersede automatically), list (active facts), get {key} (current belief + history), retire {key} (stop injecting; kept for audit). Keys are dot-slugs like 'project.repo'; categories: identity|project|infra|preference|relationship.",
    parameters: MemoryPinSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      const store = manager?.canonicalFacts?.();
      if (!store) {
        return jsonResult({ ok: false, disabled: true, error: error ?? "ledger unavailable" });
      }
      try {
        if (action === "pin") {
          const key = readStringParam(params, "key", { required: true });
          const value = readStringParam(params, "value", { required: true });
          const statement = readStringParam(params, "statement");
          const category = readStringParam(params, "category");
          const result = store.pin({
            key: key ?? "",
            value: value ?? "",
            statement: statement ?? undefined,
            category: category ?? undefined,
            confidence: 0.95, // explicit pins carry user/agent intent
            source: "agent_pin",
          });
          return jsonResult(
            result.op === "rejected" ? { ok: false, ...result } : { ok: true, ...result },
          );
        }
        if (action === "list") {
          const facts = store.listActive();
          return jsonResult({
            ok: true,
            count: facts.length,
            facts: facts.map((f) => ({
              key: f.key,
              value: f.value,
              statement: f.statement,
              category: f.category,
              confidence: f.confidence,
              mentionCount: f.mentionCount,
              lastConfirmedAt: f.lastConfirmedAt,
              source: f.source,
            })),
          });
        }
        if (action === "get") {
          const key = readStringParam(params, "key", { required: true });
          return jsonResult({
            ok: true,
            current: store.get(key ?? ""),
            history: store.history(key ?? ""),
          });
        }
        if (action === "retire") {
          const key = readStringParam(params, "key", { required: true });
          return jsonResult({ ok: store.retire(key ?? ""), key });
        }
        return jsonResult({ ok: false, error: `unknown action "${action}"` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

/**
 * PLAN-33 Phase 4: resolve ledger-first exact-key hits for a memory_search
 * query. Best-effort and non-fuzzy (see CanonicalFactsStore.lookup) — any
 * failure or a disabled ledger yields no hits and leaves semantic recall
 * untouched.
 */
function resolveCanonicalLookup(
  cfg: BitterbotConfig,
  manager: {
    canonicalFacts?: () => import("../../memory/canonical-facts.js").CanonicalFactsStore | null;
  },
  query: string,
): Array<{
  key: string;
  value: string;
  statement: string;
  category: string;
  confidence: number;
  source: string;
  match: "key" | "value";
}> {
  if (cfg.memory?.canonicalLedger?.enabled === false) {
    return [];
  }
  try {
    const store = manager.canonicalFacts?.();
    if (!store) {
      return [];
    }
    return store.lookup(query, { limit: 3 }).map((h) => ({
      key: h.fact.key,
      value: h.fact.value,
      statement: h.fact.statement,
      category: h.fact.category,
      confidence: h.fact.confidence,
      source: h.fact.source,
      match: h.matchKind,
    }));
  } catch {
    return [];
  }
}

function resolveMemoryCitationsMode(cfg: BitterbotConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
