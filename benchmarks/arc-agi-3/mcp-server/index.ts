#!/usr/bin/env -S node --import=tsx
/**
 * Bitterbot Memory MCP server.
 *
 * Exposes Bitterbot's biological-memory subsystems (knowledge graph,
 * SAGE retrieval, curiosity engine, epistemic-directive engine,
 * hormonal state manager) as MCP tools that Claude Code (and any
 * other MCP-aware agent) can call via stdio.
 *
 * Tool catalog:
 *   - memory.query
 *   - memory.record_rule
 *   - memory.log_transition
 *   - memory.get_hypothesis
 *   - memory.update_hypothesis
 *   - memory.score_novelty
 *   - memory.get_hormonal_state
 *   - memory.record_event
 *   - memory.list_rules
 *
 * Env:
 *   BITTERBOT_AGENT_DIR  (default: ~/.bitterbot/agents/arc-agi-3)
 *   OPENAI_API_KEY       (required for SAGE retrieval embeddings)
 *
 * Boot:
 *   node --import=tsx benchmarks/arc-agi-3/mcp-server/index.ts
 *   (typically invoked by Claude Code via .claude/mcp.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  runGetHormonal,
  runRecordEvent,
  GET_HORMONAL_TOOL_DEF,
  RECORD_EVENT_TOOL_DEF,
  getHormonalInputSchema,
  recordEventInputSchema,
} from "./tools/hormonal.js";
import {
  runGetHypothesis,
  runUpdateHypothesis,
  GET_HYPOTHESIS_TOOL_DEF,
  UPDATE_HYPOTHESIS_TOOL_DEF,
  getHypothesisInputSchema,
  updateHypothesisInputSchema,
} from "./tools/hypothesis.js";
import { runListRules, LIST_RULES_TOOL_DEF, listRulesInputSchema } from "./tools/list-rules.js";
import {
  runLogTransition,
  LOG_TRANSITION_TOOL_DEF,
  logTransitionInputSchema,
} from "./tools/log-transition.js";
import {
  runScoreNovelty,
  SCORE_NOVELTY_TOOL_DEF,
  scoreNoveltyInputSchema,
} from "./tools/novelty.js";
import { runQuery, QUERY_TOOL_DEF, queryInputSchema } from "./tools/query.js";
import { runRecordRule, RECORD_RULE_TOOL_DEF, recordRuleInputSchema } from "./tools/record-rule.js";

const SERVER_NAME = "bitterbot-memory";
const SERVER_VERSION = "0.1.0";

function jsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorContent(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    QUERY_TOOL_DEF.name,
    {
      title: QUERY_TOOL_DEF.title,
      description: QUERY_TOOL_DEF.description,
      inputSchema: queryInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runQuery(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    RECORD_RULE_TOOL_DEF.name,
    {
      title: RECORD_RULE_TOOL_DEF.title,
      description: RECORD_RULE_TOOL_DEF.description,
      inputSchema: recordRuleInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runRecordRule(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    LOG_TRANSITION_TOOL_DEF.name,
    {
      title: LOG_TRANSITION_TOOL_DEF.title,
      description: LOG_TRANSITION_TOOL_DEF.description,
      inputSchema: logTransitionInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runLogTransition(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    GET_HYPOTHESIS_TOOL_DEF.name,
    {
      title: GET_HYPOTHESIS_TOOL_DEF.title,
      description: GET_HYPOTHESIS_TOOL_DEF.description,
      inputSchema: getHypothesisInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runGetHypothesis(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    UPDATE_HYPOTHESIS_TOOL_DEF.name,
    {
      title: UPDATE_HYPOTHESIS_TOOL_DEF.title,
      description: UPDATE_HYPOTHESIS_TOOL_DEF.description,
      inputSchema: updateHypothesisInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runUpdateHypothesis(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    SCORE_NOVELTY_TOOL_DEF.name,
    {
      title: SCORE_NOVELTY_TOOL_DEF.title,
      description: SCORE_NOVELTY_TOOL_DEF.description,
      inputSchema: scoreNoveltyInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runScoreNovelty(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    GET_HORMONAL_TOOL_DEF.name,
    {
      title: GET_HORMONAL_TOOL_DEF.title,
      description: GET_HORMONAL_TOOL_DEF.description,
      inputSchema: getHormonalInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runGetHormonal(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    RECORD_EVENT_TOOL_DEF.name,
    {
      title: RECORD_EVENT_TOOL_DEF.title,
      description: RECORD_EVENT_TOOL_DEF.description,
      inputSchema: recordEventInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runRecordEvent(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    LIST_RULES_TOOL_DEF.name,
    {
      title: LIST_RULES_TOOL_DEF.title,
      description: LIST_RULES_TOOL_DEF.description,
      inputSchema: listRulesInputSchema,
    },
    async (input) => {
      try {
        return jsonContent(await runListRules(input));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server runs until stdin closes or an unhandled error occurs.
}

// Run as a script. (Don't run if imported, e.g. by tests.)
const argv1 = process.argv[1] ?? "";
if (argv1.endsWith("index.ts") || argv1.endsWith("index.js")) {
  main().catch((err) => {
    console.error("bitterbot-memory MCP server failed:", err);
    process.exit(1);
  });
}
