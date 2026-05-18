/**
 * memory.query — SAGE retrieval over the agent's knowledge graph.
 *
 * Returns ranked chunks + entity activations. Caller uses this BEFORE
 * deciding next action when looking for "what happened in similar
 * states before?"
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const queryInputSchema = {
  text: z.string().describe("The natural-language query to retrieve over."),
  topK: z.number().int().positive().max(50).optional().describe("Max results. Default 10."),
};

export type QueryInput = {
  text: string;
  topK?: number;
};

export interface QueryResult {
  chunks: Array<{ chunkId: string; score: number }>;
  entities: Array<{ entityId: string; entityName: string; activation: number }>;
  source: string;
  readingTimeMs: number;
}

export async function runQuery(input: QueryInput): Promise<QueryResult> {
  const ctx = await getMemoryContext();
  const topK = input.topK ?? 10;
  const { plan, graph } = await ctx.sageRetrieve(input.text, {
    queryPlanning: { enabled: true },
    graphReader: { enabled: true, hops: 2, maxFrontier: 200, topK },
    structuralGating: { enabled: true },
    hormonalModulation: { enabled: false },
  });
  return {
    chunks: graph?.chunks ?? [],
    entities: graph?.entities ?? [],
    source: plan.source,
    readingTimeMs: graph?.readingTimeMs ?? 0,
  };
}

export const QUERY_TOOL_DEF = {
  name: "memory.query",
  title: "Query biological memory",
  description:
    "Run a SAGE retrieval over the knowledge graph. Returns chunks and entity activations relevant to the query. Use this BEFORE reasoning about your next action when you suspect you've seen similar states / rules before.",
  inputSchema: queryInputSchema,
} as const;
