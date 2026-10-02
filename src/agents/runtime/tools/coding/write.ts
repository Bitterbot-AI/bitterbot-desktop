/**
 * PLAN-52 Phase 5: the `write` file tool.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/tools/write.ts`: `createWriteTool` (pi's `createWriteToolDefinition`
 * passed through its `wrapToolDefinition`), `WriteOperations`,
 * `WriteToolOptions`, `WriteToolInput`.
 *
 * Name, label, description, parameter schema, result text and error texts are
 * the same as pi's, byte for byte. The description and the schema are sent to
 * the model, so a changed character there changes the prompt cache prefix.
 *
 * Differences from the original:
 *
 * 1. Schema library. pi builds the schema with `typebox` 1.x, which is not a
 *    direct dependency of this repo. Here it is a JSON Schema literal in pi's
 *    exact key order, typed through `Type.Unsafe` of `@sinclair/typebox` 0.34
 *    and stored without typebox symbols (see `./read.ts`, difference 1). The
 *    serialized JSON is identical.
 * 2. No TUI: `renderCall`, `renderResult`, the incremental syntax highlight
 *    cache and its render component are left out.
 * 3. `promptSnippet` and `promptGuidelines` are left out. They exist on pi's
 *    `ToolDefinition` only; `createWriteTool` returns an `AgentTool`, which
 *    never had them.
 * 4. `createWriteToolDefinition` is not exported.
 *
 * Kept as in pi, on purpose: the success text reports `content.length`, which
 * is UTF-16 code units, under the word "bytes".
 */
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { toPlainJsonSchema } from "../../../schema/plain-json-schema.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";

export interface WriteToolInput {
  path: string;
  content: string;
}

const writeSchema = toPlainJsonSchema(
  Type.Unsafe<WriteToolInput>({
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Path to the file to write (relative or absolute)" },
      content: { type: "string", description: "Content to write to the file" },
    },
  }),
);

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to another system (for example a sandbox).
 */
export interface WriteOperations {
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Create directory recursively */
  mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
  /** Custom operations for file writing. Default: local filesystem */
  operations?: WriteOperations;
}

type WriteToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
};

export function createWriteTool(
  cwd: string,
  options?: WriteToolOptions,
): AgentTool<typeof writeSchema, undefined> {
  const ops = options?.operations ?? defaultWriteOperations;
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    // Present and undefined, as on the object pi's wrapToolDefinition returns.
    prepareArguments: undefined,
    executionMode: undefined,
    // async, and destructured in the parameter list, as in pi: a throw while
    // reading bad arguments is a rejection with the same TypeError text.
    // The cast only widens the argument type to what AgentTool declares for a
    // schema typebox 1.x cannot infer from (unknown).
    execute: (async (
      _toolCallId: string,
      { path, content }: WriteToolInput,
      signal?: AbortSignal,
    ): Promise<WriteToolResult> => {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);
      return withFileMutationQueue(
        absolutePath,
        () =>
          new Promise<WriteToolResult>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("Operation aborted"));
              return;
            }
            let aborted = false;
            const onAbort = () => {
              aborted = true;
              reject(new Error("Operation aborted"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            void (async () => {
              try {
                // Create parent directories if needed.
                await ops.mkdir(dir);
                if (aborted) {
                  return;
                }
                // Write the file contents.
                await ops.writeFile(absolutePath, content);
                if (aborted) {
                  return;
                }
                signal?.removeEventListener("abort", onAbort);
                resolve({
                  content: [
                    {
                      type: "text",
                      text: `Successfully wrote ${content.length} bytes to ${path}`,
                    },
                  ],
                  details: undefined,
                });
              } catch (error: unknown) {
                signal?.removeEventListener("abort", onAbort);
                if (!aborted) {
                  reject(error);
                }
              }
            })();
          }),
      );
    }) as (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<WriteToolResult>,
  };
}
