import fs from "node:fs/promises";
import { getProject, type Project, type ProjectKBFile } from "./projects.js";

/**
 * Estimate token count from file content.
 * Rough heuristic: ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ProjectContext {
  /** System prompt to inject before the agent's default system prompt */
  systemPrompt: string;
  /** Knowledge context to include in system prompt (when under threshold) */
  knowledgeContext: string | null;
  /** Whether RAG mode is active (knowledge too large for full inclusion) */
  ragActive: boolean;
  /** Total estimated tokens of knowledge base */
  totalKBTokens: number;
}

/**
 * Build the project context for injection into agent system prompt.
 *
 * Strategy:
 * - If total KB tokens < ragThresholdTokens: inject all file contents into system prompt
 * - If total KB tokens >= ragThresholdTokens: activate RAG mode (returns null knowledgeContext)
 *
 * When RAG is active, the agent should use the project-scoped memory search tool
 * to query the knowledge base on demand.
 */
export async function buildProjectContext(projectId: string): Promise<ProjectContext | null> {
  const project = getProject(projectId);
  if (!project) return null;

  const kb = project.knowledgeBase;
  const files = kb.files;

  if (files.length === 0) {
    return {
      systemPrompt: project.systemPrompt,
      knowledgeContext: null,
      ragActive: false,
      totalKBTokens: 0,
    };
  }

  // Read all files and estimate total tokens
  const fileContents: { file: ProjectKBFile; content: string }[] = [];
  let totalTokens = 0;

  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, "utf8");
      const tokens = estimateTokens(content);
      totalTokens += tokens;
      fileContents.push({ file, content });
    } catch {
      // Skip files that can't be read
    }
  }

  const threshold = kb.ragThresholdTokens;
  const ragActive = kb.autoRag && totalTokens >= threshold;

  if (ragActive) {
    // RAG mode: don't include file contents in prompt
    return {
      systemPrompt: project.systemPrompt,
      knowledgeContext: null,
      ragActive: true,
      totalKBTokens: totalTokens,
    };
  }

  // Full context mode: include all file contents
  const contextParts = fileContents.map(({ file, content }) => {
    return `<file name="${file.name}">\n${content}\n</file>`;
  });

  const knowledgeContext = `<project-knowledge>\n${contextParts.join("\n\n")}\n</project-knowledge>`;

  return {
    systemPrompt: project.systemPrompt,
    knowledgeContext,
    ragActive: false,
    totalKBTokens: totalTokens,
  };
}
