/**
 * RLM Sandbox — Secure JavaScript execution environment using Node.js vm module.
 *
 * The sandbox provides a minimal, isolated REPL where LLM-generated code can
 * explore a loaded context string. No filesystem, network, or require access.
 *
 * Based on: "Recursive Language Models" (Zhang, Kraska, Khattab, 2026)
 * Paper: https://arxiv.org/abs/2512.24601
 * Reference: hampton-io/RLM (TypeScript)
 */

import { createContext, Script, type Context } from "node:vm";
import type { SandboxExecutionResult } from "./types.js";

export type SandboxOptions = {
  /** The full context string to explore. */
  context: string;
  /** Per-execution timeout in ms. Default: 30000. */
  timeout?: number;
  /** Async callback for recursive LLM sub-calls. */
  onLLMQuery: (prompt: string, subContext?: string) => Promise<string>;
  /** Async callback for parallel LLM sub-calls. */
  onLLMQueryParallel?: (queries: Array<{ prompt: string; context?: string }>) => Promise<string[]>;
};

export class RLMSandbox {
  private vmContext: Context;
  private output: string[] = [];
  private persistentStore = new Map<string, unknown>();
  private finalAnswer: string | null = null;
  private finalVarName: string | null = null;
  private readonly timeout: number;

  constructor(private options: SandboxOptions) {
    this.timeout = options.timeout ?? 30_000;
    this.vmContext = this.buildContext();
  }

  private buildContext(): Context {
    // Chunk text into pieces of `size` characters with optional overlap
    function chunk(text: string, size: number, overlap = 0): string[] {
      if (!text || size <= 0) {
        return [];
      }
      const step = Math.max(1, size - overlap);
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += step) {
        chunks.push(text.slice(i, i + size));
      }
      return chunks;
    }

    // Filter lines matching a pattern
    function grep(text: string, pattern: string | RegExp): string[] {
      const re = typeof pattern === "string" ? new RegExp(pattern, "gi") : pattern;
      return text.split("\n").filter((line) => re.test(line));
    }

    // Count lines in text
    function lineCount(text: string): number {
      if (!text) {
        return 0;
      }
      return text.split("\n").length;
    }

    // Get lines from text by range (1-indexed)
    function getLines(text: string, from: number, to?: number): string {
      const lines = text.split("\n");
      const start = Math.max(0, from - 1);
      const end = to !== undefined ? Math.min(lines.length, to) : lines.length;
      return lines.slice(start, end).join("\n");
    }

    // Extract all unique matches of a regex pattern
    function extractAll(text: string, pattern: string | RegExp): string[] {
      const re = typeof pattern === "string" ? new RegExp(pattern, "gi") : pattern;
      const matches = text.match(re);
      return matches ? [...new Set(matches)] : [];
    }

    // Count occurrences of a pattern
    function countMatches(text: string, pattern: string | RegExp): number {
      const re = typeof pattern === "string" ? new RegExp(pattern, "gi") : pattern;
      const matches = text.match(re);
      return matches ? matches.length : 0;
    }

    // Summarize text stats
    function textStats(text: string): { chars: number; lines: number; words: number } {
      return {
        chars: text.length,
        lines: text.split("\n").length,
        words: text.split(/\s+/).filter(Boolean).length,
      };
    }

    return createContext({
      // The context data to explore
      context: this.options.context,

      // Output capture
      print: (...args: unknown[]) => {
        this.output.push(args.map(String).join(" "));
      },
      console: {
        log: (...args: unknown[]) => {
          this.output.push(args.map(String).join(" "));
        },
        error: (...args: unknown[]) => {
          this.output.push(`ERROR: ${args.map(String).join(" ")}`);
        },
        warn: (...args: unknown[]) => {
          this.output.push(`WARN: ${args.map(String).join(" ")}`);
        },
      },

      // LLM recursive sub-calls
      llm_query: this.options.onLLMQuery,
      llm_query_parallel:
        this.options.onLLMQueryParallel ??
        (async (queries: Array<{ prompt: string; context?: string }>) => {
          // Fallback: sequential execution if parallel not provided
          const results: string[] = [];
          for (const q of queries) {
            results.push(await this.options.onLLMQuery(q.prompt, q.context));
          }
          return results;
        }),

      // Text utility functions
      chunk,
      grep,
      len: (text: string) => text.length,
      lineCount,
      getLines,
      extractAll,
      countMatches,
      textStats,
      slice: (text: string, start: number, end?: number) => text.slice(start, end),
      split: (text: string, sep: string) => text.split(sep),
      join: (arr: string[], sep: string) => arr.join(sep),
      includes: (text: string, sub: string) => text.includes(sub),
      indexOf: (text: string, sub: string, from?: number) => text.indexOf(sub, from),
      replace: (text: string, pattern: string | RegExp, replacement: string) =>
        text.replace(pattern, replacement),
      toLowerCase: (text: string) => text.toLowerCase(),
      toUpperCase: (text: string) => text.toUpperCase(),
      trim: (text: string) => text.trim(),
      startsWith: (text: string, prefix: string) => text.startsWith(prefix),
      endsWith: (text: string, suffix: string) => text.endsWith(suffix),

      // Persistent storage across code blocks
      store: (name: string, value: unknown) => {
        this.persistentStore.set(name, value);
        return value;
      },
      get: (name: string) => this.persistentStore.get(name),
      has: (name: string) => this.persistentStore.has(name),

      // Completion signals
      FINAL: (answer: string) => {
        this.finalAnswer = String(answer);
      },
      FINAL_VAR: (varName: string) => {
        this.finalVarName = String(varName);
      },

      // Standard builtins (safe subset)
      JSON,
      Math,
      RegExp,
      Map,
      Set,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      Error,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      undefined,
      null: null,
      NaN,
      Infinity,

      // Intentionally NOT provided:
      // - require, import, module, exports
      // - fs, path, child_process, os, net, http, https, dns
      // - fetch, XMLHttpRequest, WebSocket
      // - process, Buffer, global, globalThis
      // - eval (vm prevents this anyway)
      // - setTimeout/setInterval (avoid async complexity in sandbox)
    });
  }

  /**
   * Execute a code block in the sandbox.
   * The code is wrapped in an async IIFE so `await` works for llm_query calls.
   * Uses Promise.race with a hard timeout to cover async operations (like llm_query)
   * that run outside the VM's synchronous timeout.
   */
  async execute(code: string): Promise<SandboxExecutionResult> {
    this.output = [];
    try {
      // Wrap in async IIFE for await support
      const wrappedCode = `(async () => {\n${code}\n})()`;
      const script = new Script(wrappedCode, {
        filename: "rlm-sandbox.js",
      });
      const execution = script.runInContext(this.vmContext, { timeout: this.timeout });
      // Hard outer timeout covers async operations (llm_query, etc.)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Sandbox execution timed out")), this.timeout + 5000);
      });
      await Promise.race([execution, timeoutPromise]);
      return { output: this.output.join("\n") };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { output: this.output.join("\n"), error: errorMsg };
    }
  }

  /** Get the final answer if FINAL() was called. */
  getFinalAnswer(): string | null {
    return this.finalAnswer;
  }

  /** Get the variable name if FINAL_VAR() was called. */
  getFinalVarName(): string | null {
    return this.finalVarName;
  }

  /** Resolve the final answer: check FINAL first, then FINAL_VAR, then null. */
  resolveFinalAnswer(): string | null {
    if (this.finalAnswer !== null) {
      return this.finalAnswer;
    }
    if (this.finalVarName !== null) {
      const value = this.persistentStore.get(this.finalVarName);
      if (value !== undefined) {
        return String(value);
      }
    }
    return null;
  }

  /** Get a stored variable by name. */
  getVariable(name: string): unknown {
    return this.persistentStore.get(name);
  }

  /** Get the last captured output. */
  getLastOutput(): string {
    return this.output.join("\n");
  }

  /** Reset for reuse (keeps context string, clears state). */
  reset(): void {
    this.output = [];
    this.persistentStore.clear();
    this.finalAnswer = null;
    this.finalVarName = null;
    this.vmContext = this.buildContext();
  }

  dispose(): void {
    this.output = [];
    this.persistentStore.clear();
    this.finalAnswer = null;
    this.finalVarName = null;
    // Release the VM context and its reference to the (potentially large) context string
    this.vmContext = createContext({});
  }
}
