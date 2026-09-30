import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Model, Tool } from "@mariozechner/pi-ai";
import { expect } from "vitest";

type GoogleShared = {
  convertMessages: (
    model: Model<"google-generative-ai">,
    context: Context,
  ) => Array<{ role: string; parts?: unknown[] }>;
  convertTools: (tools: Tool[]) => ConvertedTools | undefined;
};

/**
 * pi-ai >= 0.73 has an `exports` map that hides dist/providers/google-shared.js,
 * so locate the package directory and load it by file URL. These tests
 * guard upstream Google message conversion behaviour we rely on.
 */
export async function loadGoogleShared(): Promise<GoogleShared> {
  const require = createRequire(import.meta.url);
  for (const dir of require.resolve.paths("@mariozechner/pi-ai") ?? []) {
    const file = path.join(dir, "@mariozechner/pi-ai/dist/providers/google-shared.js");
    if (fs.existsSync(file)) {
      return (await import(pathToFileURL(file).href)) as GoogleShared;
    }
  }
  throw new Error("@mariozechner/pi-ai google-shared.js not found");
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

type ConvertedTools = ReadonlyArray<{
  functionDeclarations?: ReadonlyArray<{
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }>;
}>;

export const getFirstToolParameters = (converted: ConvertedTools): Record<string, unknown> => {
  const functionDeclaration = asRecord(converted?.[0]?.functionDeclarations?.[0]);
  return asRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};

export const makeModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

export const makeGeminiCliModel = (id: string): Model<"google-gemini-cli"> =>
  ({
    id,
    name: id,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-gemini-cli">;

function makeZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: makeZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function makeGeminiCliAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    model,
    usage: makeZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}
