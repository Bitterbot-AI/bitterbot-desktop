/**
 * How an approved action is carried out on the gateway (PLAN-53 B5).
 *
 * Each gated tool gets a small executor that builds the tool with the node's
 * config and runs the stored call with owner authority. Nothing here goes
 * through the review stage again: `runAsApproved` in the service marks the
 * call, and the tools are built directly rather than through the hooked set.
 */

import type { BitterbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { ApprovedExecutor, ExecutionResult } from "./service.js";
import type { ReviewAction } from "./store.js";

type ToolLike = {
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
};

/** A tool result is `{ content: [{type:"text", text}], details }`; keep the text. */
export function summarizeToolResult(result: unknown): ExecutionResult {
  if (!result || typeof result !== "object") {
    return { ok: true, summary: "done" };
  }
  const r = result as { content?: unknown; details?: unknown };
  const texts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") texts.push(t);
      }
    }
  }
  const details =
    r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null;
  const failed =
    details?.status === "error" ||
    (typeof details?.error === "string" && details.error.length > 0) ||
    details?.ok === false;
  const summary =
    (typeof details?.error === "string" && details.error) ||
    texts.join("\n").trim() ||
    (details ? JSON.stringify(details).slice(0, 1000) : "done");
  return { ok: !failed, summary: summary.slice(0, 2000) };
}

async function runTool(tool: ToolLike | undefined, action: ReviewAction): Promise<ExecutionResult> {
  if (!tool) {
    return { ok: false, summary: `the ${action.tool} tool is not available on this node` };
  }
  const result = await tool.execute(`review:${action.id}`, action.params);
  return summarizeToolResult(result);
}

export function createDefaultExecutors(
  getConfig: () => BitterbotConfig = loadConfig,
): Map<string, ApprovedExecutor> {
  const executors = new Map<string, ApprovedExecutor>();

  executors.set("wallet", async (action) => {
    const { createWalletTool } = await import("../agents/tools/wallet-tool.js");
    const tool = createWalletTool({ config: getConfig() }) as ToolLike | undefined;
    return runTool(tool, action);
  });

  executors.set("message", async (action) => {
    const { createMessageTool } = await import("../agents/tools/message-tool.js");
    const tool = createMessageTool({ config: getConfig() }) as unknown as ToolLike;
    return runTool(tool, action);
  });

  return executors;
}
