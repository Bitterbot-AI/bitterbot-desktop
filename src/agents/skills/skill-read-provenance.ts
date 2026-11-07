import { createHash } from "node:crypto";
import path from "node:path";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { taskChecksHash } from "../../tasks/checks.js";
import { getActiveTaskStore } from "../../tasks/store.js";
import { parseSkillFrontmatter } from "./skill-loader.js";

/** Internal read result metadata; never supplied by the model. */
export interface SkillReadContext {
  runId: string;
  senderIsOwner: boolean;
  sessionKey: string;
  task?: {
    id: string;
    hash: string;
    revision: number;
    updatedAt: number;
    author: "model" | "operator" | "unknown";
  };
}

export interface SkillReadProof {
  version: 1;
  path: string;
  name: string;
  hash: string;
  complete: boolean;
  context?: SkillReadContext;
}

export function isSkillReadPath(file: unknown): file is string {
  return (
    typeof file === "string" &&
    file.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() === "skill.md"
  );
}

export function captureSkillReadContext(params: {
  runId?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
}): SkillReadContext | undefined {
  if (!params.runId || !params.sessionKey) return undefined;
  const context: SkillReadContext = {
    runId: params.runId,
    senderIsOwner: params.senderIsOwner === true,
    sessionKey: params.sessionKey,
  };
  const taskId = getAgentRunContext(params.runId)?.taskId;
  const task = taskId ? getActiveTaskStore()?.get(taskId) : undefined;
  if (task && task.currentRunId === params.runId) {
    context.task = {
      id: task.id,
      hash: taskChecksHash(task.checks),
      revision: task.checksRevision ?? 0,
      updatedAt: Math.max(task.createdAt, task.checksUpdatedAt ?? 0),
      author: "model",
    };
  }
  return context;
}

export function skillReadProof(
  file: string,
  buffer: Buffer,
  complete: boolean,
  context?: SkillReadContext,
): SkillReadProof | undefined {
  if (!isSkillReadPath(file)) return undefined;
  try {
    const frontmatter = parseSkillFrontmatter(buffer.toString("utf8"));
    const name = frontmatter.name || path.basename(path.dirname(file));
    if (
      typeof name !== "string" ||
      !name ||
      typeof frontmatter.description !== "string" ||
      !frontmatter.description.trim()
    )
      return undefined;
    return {
      version: 1,
      path: file,
      name,
      complete,
      context,
      hash: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch {
    // Telemetry must never prevent the tool from returning the file.
    return undefined;
  }
}
