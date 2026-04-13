/**
 * LongMemEval Adapter for Bitterbot
 *
 * Bridges LongMemEval's chat-history-based evaluation format with
 * Bitterbot's biological memory system. Handles ingestion of timestamped
 * conversation histories, memory search, and LLM-based answer generation.
 *
 * LongMemEval (ICLR 2025): https://github.com/xiaowu0162/LongMemEval
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ──

export interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

export interface LongMemEvalResult {
  question_id: string;
  hypothesis: string;
}

export interface MemoryChunk {
  id: string;
  text: string;
  score: number;
  path?: string;
  startLine?: number;
  endLine?: number;
  source?: string;
}

export interface AdapterConfig {
  /** Path to LongMemEval JSON data file */
  dataPath: string;
  /** Working directory for temporary session files */
  workDir: string;
  /** Max results per memory search */
  maxSearchResults: number;
  /** Model to use for answer generation */
  answerModel: string;
  /** Max concurrent ingestion tasks */
  concurrency: number;
  /** Whether to include session timestamps in ingested text */
  includeTimestamps: boolean;
  /** Whether to use temporal knowledge graph for temporal questions */
  useTemporalKG: boolean;
  /** Whether to use reconsolidation for knowledge-update questions */
  useReconsolidation: boolean;
}

export const DEFAULT_CONFIG: AdapterConfig = {
  dataPath: join(__dirname, "data", "longmemeval_s.json"),
  workDir: join(__dirname, ".work"),
  maxSearchResults: 20,
  answerModel: "openai/gpt-4o",
  concurrency: 5,
  includeTimestamps: true,
  useTemporalKG: true,
  useReconsolidation: true,
};

// ── Session Conversion ──

/**
 * Convert a LongMemEval chat session into a timestamped markdown document
 * suitable for ingestion into Bitterbot's memory pipeline.
 */
export function sessionToMarkdown(
  session: Array<{ role: string; content: string; has_answer?: boolean }>,
  date: string,
  sessionId: string,
): string {
  const lines: string[] = [`# Chat Session ${sessionId}`, `**Date:** ${date}`, ""];

  for (const turn of session) {
    const prefix = turn.role === "user" ? "**User:**" : "**Assistant:**";
    lines.push(`${prefix} ${turn.content}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Convert all sessions for a single evaluation item into markdown files.
 * Returns the paths of the generated files.
 */
export function convertItemSessions(item: LongMemEvalItem, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  const paths: string[] = [];

  for (let i = 0; i < item.haystack_sessions.length; i++) {
    const session = item.haystack_sessions[i];
    const date = item.haystack_dates[i] ?? "unknown";
    const sessionId = item.haystack_session_ids[i] ?? `session_${i}`;
    const filename = `${sessionId}.md`;
    const filepath = join(outputDir, filename);

    const markdown = sessionToMarkdown(session, date, sessionId);
    writeFileSync(filepath, markdown, "utf-8");
    paths.push(filepath);
  }

  return paths;
}

/**
 * Convert all sessions for a single evaluation item into a SINGLE chronological
 * document. This is critical for multi-session questions: chunking creates
 * overlapping chunks that span session boundaries, enabling cross-session reasoning.
 */
export function convertItemToDocument(item: LongMemEvalItem, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });

  // Index and sort sessions chronologically
  const indexed = item.haystack_sessions.map((session, i) => ({
    session,
    date: item.haystack_dates[i] ?? "unknown",
    id: item.haystack_session_ids[i] ?? `session_${i}`,
  }));
  indexed.sort((a, b) => a.date.localeCompare(b.date));

  const lines: string[] = ["# Conversation History", ""];

  for (const { session, date, id } of indexed) {
    lines.push(`## Session ${id} — ${date}`, "");
    for (const turn of session) {
      const prefix = turn.role === "user" ? "**User:**" : "**Assistant:**";
      lines.push(`${prefix} ${turn.content}`, "");
    }
    lines.push("---", "");
  }

  const filepath = join(outputDir, "sessions.md");
  writeFileSync(filepath, lines.join("\n"), "utf-8");
  return filepath;
}

// ── Answer Generation Prompt ──

export function buildAnswerPrompt(
  question: string,
  questionDate: string,
  questionType: string,
  retrievedChunks: MemoryChunk[],
): string {
  const contextBlock = retrievedChunks
    .map((chunk, i) => {
      const text = chunk.text || (chunk as unknown as { snippet?: string }).snippet || "";
      return `[${i + 1}] (score: ${chunk.score.toFixed(3)})\n${text}`;
    })
    .join("\n\n");

  // Tailor instructions based on question type
  let typeHint = "";
  switch (questionType) {
    case "temporal-reasoning":
      typeHint =
        "Pay careful attention to dates and timeframes. The answer may depend on WHEN something happened relative to other events.";
      break;
    case "knowledge-update":
      typeHint =
        "Information may have changed over time. Use the MOST RECENT information available, not earlier/outdated versions.";
      break;
    case "multi-session":
      typeHint =
        "The answer requires connecting information from multiple different conversations. Look for relationships between pieces of evidence.";
      break;
    case "single-session-preference":
      typeHint = "The answer is about a personal preference or opinion the user expressed.";
      break;
    default:
      if (question.endsWith("_abs")) {
        typeHint =
          "If the conversation history does NOT contain sufficient evidence to answer this question, say 'I don't have enough information to answer this question.' Do NOT guess or make up an answer.";
      }
      break;
  }

  const isAbstention = question.endsWith("_abs") || questionType.endsWith("_abs");

  if (isAbstention) {
    return `Below are excerpts from past conversations with the user. Read them carefully.

${contextBlock}

The current date is: ${questionDate}
${typeHint ? `\n${typeHint}\n` : ""}
Question: ${question}

If the conversations above do NOT contain information to answer this question, respond ONLY with: "I don't have enough information to answer this question."
Otherwise, answer concisely.

Answer:`;
  }

  return `Below are excerpts from past conversations with the user. Read them carefully, then answer the question.

${contextBlock}

The current date is: ${questionDate}
${typeHint ? `\n${typeHint}\n` : ""}
Question: ${question}

Using ONLY the conversation excerpts above, provide a short, direct answer. Extract the specific information requested. If the excerpts do not contain enough information to answer confidently, say "I don't have enough information to answer this question."

Answer:`;
}

// ── Abstention Detection ──

export function isAbstentionQuestion(item: LongMemEvalItem): boolean {
  return item.question_id.endsWith("_abs");
}

// ── Results I/O ──

export function writeResults(results: LongMemEvalResult[], outputPath: string): void {
  const lines = results.map((r) => JSON.stringify(r));
  writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
}

export function readResults(path: string): LongMemEvalResult[] {
  const content = readFileSync(path, "utf-8").trim();
  return content.split("\n").map((line) => JSON.parse(line));
}

// ── Data Loading ──

export function loadDataset(path: string): LongMemEvalItem[] {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

// ── Cleanup ──

export function cleanWorkDir(workDir: string): void {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
}
