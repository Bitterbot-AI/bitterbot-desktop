/**
 * PLAN-52 Phase 5: the `edit` file tool.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/tools/edit.ts`: `createEditTool` (pi's `createEditToolDefinition`
 * passed through its `wrapToolDefinition`), `prepareEditArguments`,
 * `validateEditInput`, `EditOperations`, `EditToolOptions`, `EditToolDetails`,
 * `EditToolInput`.
 *
 * Name, label, description, parameter schema, the `prepareArguments` shim,
 * result text and error texts are the same as pi's, byte for byte. The
 * description and the schema are sent to the model, so a changed character
 * there changes the prompt cache prefix.
 *
 * Differences from the original:
 *
 * 1. Schema library. pi builds the schema with `typebox` 1.x, which is not a
 *    direct dependency of this repo. Here it is a JSON Schema literal in pi's
 *    exact key order, typed through `Type.Unsafe` of `@sinclair/typebox` 0.34
 *    and stored without typebox symbols (see `./read.ts`, difference 1). The
 *    serialized JSON is identical.
 * 2. `details.diff` is built with our port of jsdiff's line diff (see
 *    `./edit-diff.ts` and `./line-diff.ts`).
 * 3. No TUI: `renderCall`, `renderResult`, `renderShell`, the diff preview
 *    state and components are left out, and with them pi's `renderDiff`.
 * 4. `promptSnippet` and `promptGuidelines` are left out. They exist on pi's
 *    `ToolDefinition` only; `createEditTool` returns an `AgentTool`, which
 *    never had them.
 * 5. `createEditToolDefinition` is not exported.
 *
 * Kept as in pi, on purpose:
 * - `prepareArguments` mutates the object it is given when `edits` arrives as
 *   a JSON string (it replaces the string with the parsed array in place).
 * - When the legacy `oldText` / `newText` pair is present next to `edits[]`,
 *   the pair is appended as the last edit.
 */
import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { toPlainJsonSchema } from "../../../schema/plain-json-schema.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

const editSchema = toPlainJsonSchema(
  Type.Unsafe<EditToolInput>({
    type: "object",
    required: ["path", "edits"],
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
      edits: {
        type: "array",
        items: {
          type: "object",
          required: ["oldText", "newText"],
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            },
            newText: { type: "string", description: "Replacement text for this targeted edit." },
          },
          additionalProperties: false,
        },
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      },
    },
    additionalProperties: false,
  }),
);

type LegacyEditToolInput = EditToolInput & {
  oldText?: unknown;
  newText?: unknown;
};

export interface EditToolDetails {
  /** Unified diff of the changes made */
  diff: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to another system (for example a sandbox).
 */
export interface EditOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

/**
 * Compatibility shim that runs before schema validation: parses `edits` when a
 * model sent it as a JSON string, and folds the legacy top-level
 * `oldText` / `newText` pair into `edits[]`.
 */
function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = input as Record<string, unknown>;

  // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) {
        args.edits = parsed;
      }
    } catch {}
  }

  const legacy = args as unknown as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as unknown as EditToolInput;
  }

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy;
  return { ...rest, edits };
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

type EditToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: EditToolDetails | undefined;
};

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): AgentTool<typeof editSchema, EditToolDetails | undefined> {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    // Present and undefined, as on the object pi's wrapToolDefinition returns.
    executionMode: undefined,
    // async, as in pi: a throw while reading the arguments is a rejection, not a sync throw.
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const { path, edits } = validateEditInput(params as EditToolInput);
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(
        absolutePath,
        () =>
          new Promise<EditToolResult>((resolve, reject) => {
            // Check if already aborted.
            if (signal?.aborted) {
              reject(new Error("Operation aborted"));
              return;
            }

            let aborted = false;

            // Set up abort handler.
            const onAbort = () => {
              aborted = true;
              reject(new Error("Operation aborted"));
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            // Perform the edit operation.
            void (async () => {
              try {
                // Check if file exists.
                try {
                  await ops.access(absolutePath);
                } catch (error: unknown) {
                  const errorMessage =
                    error instanceof Error && "code" in error
                      ? `Error code: ${String(error.code)}`
                      : String(error);
                  if (signal) {
                    signal.removeEventListener("abort", onAbort);
                  }
                  reject(new Error(`Could not edit file: ${path}. ${errorMessage}.`));
                  return;
                }

                // Check if aborted before reading.
                if (aborted) {
                  return;
                }

                // Read the file.
                const buffer = await ops.readFile(absolutePath);
                const rawContent = buffer.toString("utf-8");

                // Check if aborted after reading.
                if (aborted) {
                  return;
                }

                // Strip BOM before matching. The model will not include an invisible BOM in oldText.
                const { bom, text: content } = stripBom(rawContent);
                const originalEnding = detectLineEnding(content);
                const normalizedContent = normalizeToLF(content);
                const { baseContent, newContent } = applyEditsToNormalizedContent(
                  normalizedContent,
                  edits,
                  path,
                );

                // Check if aborted before writing.
                if (aborted) {
                  return;
                }

                const finalContent = bom + restoreLineEndings(newContent, originalEnding);
                await ops.writeFile(absolutePath, finalContent);

                // Check if aborted after writing.
                if (aborted) {
                  return;
                }

                // Clean up abort handler.
                if (signal) {
                  signal.removeEventListener("abort", onAbort);
                }

                const diffResult = generateDiffString(baseContent, newContent);
                resolve({
                  content: [
                    {
                      type: "text",
                      text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
                    },
                  ],
                  details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
                });
              } catch (error: unknown) {
                // Clean up abort handler.
                if (signal) {
                  signal.removeEventListener("abort", onAbort);
                }

                if (!aborted) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              }
            })();
          }),
      );
    },
  };
}
