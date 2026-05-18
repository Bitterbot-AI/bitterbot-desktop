/**
 * LongMemEval bridge: LLM-driven entity + relationship extractor.
 *
 * The default Bitterbot session-extractor (`manager.runSessionExtraction`)
 * runs during dream cycles, scans the agent's sessions directory, and
 * uses a brittle regex heuristic to derive entities (capitalized names
 * for "relationship" facts, a hardcoded tool whitelist for "world_fact"
 * facts). For LongMemEval haystack content this populates almost
 * nothing — so the SAGE graph channel would silently return [].
 *
 * This module bypasses that path. It takes raw session text, asks a
 * fast LLM (Haiku) to produce a clean entity/relationship JSON, and
 * returns the result in the exact shape `KnowledgeGraphManager.ingestExtraction`
 * expects. The benchmark bridge calls this on each ingested session so
 * the knowledge graph is actually populated for SAGE retrieval.
 */

import type {
  EntityType,
  ExtractedEntity,
  ExtractedRelationship,
  RelationType,
} from "../../src/memory/knowledge-graph.js";

const ENTITY_TYPES: EntityType[] = [
  "person",
  "project",
  "concept",
  "tool",
  "organization",
  "location",
  "file",
  "service",
  "event",
];

const RELATION_TYPES: RelationType[] = [
  "works_on",
  "manages",
  "depends_on",
  "uses",
  "created_by",
  "belongs_to",
  "related_to",
  "contradicts",
  "located_at",
  "part_of",
  "knows",
  "prefers",
  "caused_by",
];

export type ExtractionLlmCall = (params: {
  model: string;
  prompt: string;
  maxTokens?: number;
}) => Promise<string>;

export type EntityExtractionResult = {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  modelUsed: string;
  durationMs: number;
  tokenEstimate: number;
};

export type ExtractionOptions = {
  /** Model spec to use. Default Haiku 4.5 (fast + cheap). */
  model?: string;
  /** Max session chars sent to the LLM. Default 6000. */
  maxInputChars?: number;
  /** Max output tokens. Default 1024. */
  maxOutputTokens?: number;
  /** Hard timeout to bound worst-case latency. Default 30s. */
  timeoutMs?: number;
};

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";
const DEFAULT_MAX_INPUT = 6000;
const DEFAULT_MAX_OUTPUT = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function buildPrompt(sessionText: string): string {
  return `You are an entity-extraction system. Read the conversation transcript below and produce a strict JSON object listing named entities and the typed relationships between them.

ENTITY TYPES (use exactly one):
person, project, concept, tool, organization, location, file, service, event

RELATION TYPES (use exactly one):
works_on, manages, depends_on, uses, created_by, belongs_to, related_to, contradicts, located_at, part_of, knows, prefers, caused_by

RULES:
- Only include NAMED things — proper nouns, specific identifiers, official tool names. Skip generic concepts ("the database", "a meeting").
- Be conservative: skip when you are uncertain. Precision beats recall here.
- For each relationship, BOTH endpoint entities must also appear in the entities list.
- Up to 20 entities, up to 30 relationships.
- Output ONLY the JSON object, no markdown fences, no commentary.

OUTPUT SHAPE:
{
  "entities": [
    { "name": "Alice", "type": "person" }
  ],
  "relationships": [
    { "source": "Alice", "sourceType": "person", "target": "Project-X", "targetType": "project", "relation": "works_on" }
  ]
}

CONVERSATION:
${sessionText}`;
}

type RawEntity = { name?: unknown; type?: unknown };
type RawRelationship = {
  source?: unknown;
  sourceType?: unknown;
  target?: unknown;
  targetType?: unknown;
  relation?: unknown;
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function validEntityType(v: unknown): EntityType | null {
  const s = asString(v)?.toLowerCase();
  if (!s) return null;
  return (ENTITY_TYPES as string[]).includes(s) ? (s as EntityType) : null;
}

function validRelationType(v: unknown): RelationType | null {
  const s = asString(v)?.toLowerCase();
  if (!s) return null;
  return (RELATION_TYPES as string[]).includes(s) ? (s as RelationType) : null;
}

function parseExtractionResponse(raw: string): {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
} {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { entities: [], relationships: [] };
  }
  let parsed: { entities?: RawEntity[]; relationships?: RawRelationship[] };
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { entities: [], relationships: [] };
  }

  const entities: ExtractedEntity[] = [];
  const seenEntity = new Set<string>();
  if (Array.isArray(parsed.entities)) {
    for (const e of parsed.entities) {
      const name = asString(e.name);
      const type = validEntityType(e.type);
      if (!name || !type) continue;
      const key = `${type}:${name.toLowerCase()}`;
      if (seenEntity.has(key)) continue;
      seenEntity.add(key);
      entities.push({ name, type });
      if (entities.length >= 30) break;
    }
  }

  const relationships: ExtractedRelationship[] = [];
  const validNames = new Set(entities.map((e) => `${e.type}:${e.name.toLowerCase()}`));
  if (Array.isArray(parsed.relationships)) {
    for (const r of parsed.relationships) {
      const source = asString(r.source);
      const target = asString(r.target);
      const sourceType = validEntityType(r.sourceType);
      const targetType = validEntityType(r.targetType);
      const relationType = validRelationType(r.relation);
      if (!source || !target || !sourceType || !targetType || !relationType) continue;
      // Require both endpoints to be in the entities list — keeps the
      // graph internally consistent.
      const srcKey = `${sourceType}:${source.toLowerCase()}`;
      const tgtKey = `${targetType}:${target.toLowerCase()}`;
      if (!validNames.has(srcKey) || !validNames.has(tgtKey)) continue;
      relationships.push({
        sourceName: source,
        sourceType,
        targetName: target,
        targetType,
        relationType,
        weight: 0.7,
      });
      if (relationships.length >= 40) break;
    }
  }

  return { entities, relationships };
}

/**
 * Extract entities and relationships from a single session's text.
 *
 * Falls back to an empty result on any failure (LLM error, JSON parse
 * failure, timeout). Caller is expected to ingest the result into the
 * knowledge graph via `KnowledgeGraphManager.ingestExtraction`.
 */
export async function extractEntitiesFromSession(
  sessionText: string,
  llmCall: ExtractionLlmCall,
  opts: ExtractionOptions = {},
): Promise<EntityExtractionResult> {
  const start = Date.now();
  const model = opts.model ?? DEFAULT_MODEL;
  const maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Truncate long sessions — cost control. The extractor only needs
  // enough signal to identify named entities; full transcripts are
  // wasteful.
  const truncated =
    sessionText.length > maxInputChars
      ? sessionText.slice(0, maxInputChars) + "\n[...truncated]"
      : sessionText;

  const prompt = buildPrompt(truncated);

  let response = "";
  try {
    const llmPromise = llmCall({ model, prompt, maxTokens: maxOutputTokens });
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error("extractor timeout")), timeoutMs);
    });
    try {
      response = await Promise.race([llmPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return {
      entities: [],
      relationships: [],
      modelUsed: model,
      durationMs: Date.now() - start,
      tokenEstimate: 0,
    };
  }

  const { entities, relationships } = parseExtractionResponse(response);
  return {
    entities,
    relationships,
    modelUsed: model,
    durationMs: Date.now() - start,
    tokenEstimate: Math.ceil((prompt.length + response.length) / 4),
  };
}
