/**
 * PLAN-52 Phase 5: the `read` file tool.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/tools/read.ts`: `createReadTool` (pi's `createReadToolDefinition`
 * passed through its `wrapToolDefinition`), `ReadOperations`,
 * `ReadToolOptions`, `ReadToolDetails`, `ReadToolInput`.
 *
 * Name, label, description, parameter schema, result texts and error texts
 * are the same as pi's, byte for byte. The description and the schema are sent
 * to the model, so a changed character there changes the prompt cache prefix.
 *
 * Differences from the original:
 *
 * 1. Schema library. pi builds the schema with `typebox` 1.x, which is not a
 *    direct dependency of this repo. Here it is a JSON Schema literal in pi's
 *    exact key order, typed through `Type.Unsafe` of `@sinclair/typebox` 0.34
 *    (whose `Type.Object` / `Type.String` builders emit keys in a different
 *    order) and stored without typebox symbols. pi's schema object carries no
 *    symbols either; it has a non-enumerable `~kind` marker that ours lacks.
 *    The serialized JSON is identical.
 * 2. Images are resized with `sharp` instead of Photon (see
 *    `./image-resize.ts`).
 * 3. No TUI: `renderCall`, `renderResult`, the compact skill/docs/resource
 *    call line, syntax highlighting and key hints are left out, and with them
 *    pi's `render-utils.ts`, theme, `keybinding-hints.ts` and `config.ts`.
 * 4. `promptSnippet` and `promptGuidelines` are left out. They exist on pi's
 *    `ToolDefinition` only; `createReadTool` returns an `AgentTool`, which
 *    never had them.
 * 5. The "[Current model does not support images...]" note is left out. It
 *    needs the extension context pi passes as a fifth `execute` argument, and
 *    `createReadTool` never passes one, so the note was unreachable through
 *    this factory.
 * 6. `createReadToolDefinition` is not exported; nothing here uses pi's
 *    `ToolDefinition` shape.
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { toPlainJsonSchema } from "../../../schema/plain-json-schema.js";
import { formatDimensionNote, resizeImage } from "./image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "./mime.js";
import { resolveReadPath } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "./truncate.js";

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

const readSchema = toPlainJsonSchema(
  Type.Unsafe<ReadToolInput>({
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)" },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
  }),
);

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to another system (for example a sandbox).
 */
export interface ReadOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type, return null or undefined for non-images */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
  /** Whether to auto-resize images to 2000x2000 max. Default: true */
  autoResizeImages?: boolean;
  /** Custom operations for file reading. Default: local filesystem */
  operations?: ReadOperations;
}

type ReadToolResult = {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails | undefined;
};

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    // Present and undefined, as on the object pi's wrapToolDefinition returns.
    prepareArguments: undefined,
    executionMode: undefined,
    // async, and destructured in the parameter list, as in pi: a throw while
    // reading bad arguments is a rejection with the same TypeError text.
    // The cast only widens the argument type to what AgentTool declares for a
    // schema typebox 1.x cannot infer from (unknown).
    execute: (async (
      _toolCallId: string,
      { path, offset, limit }: ReadToolInput,
      signal?: AbortSignal,
    ): Promise<ReadToolResult> => {
      const absolutePath = resolveReadPath(path, cwd);
      return new Promise<ReadToolResult>((resolve, reject) => {
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
            // Check if file exists and is readable.
            await ops.access(absolutePath);
            if (aborted) {
              return;
            }
            const mimeType = ops.detectImageMimeType
              ? await ops.detectImageMimeType(absolutePath)
              : undefined;
            let content: (TextContent | ImageContent)[];
            let details: ReadToolDetails | undefined;
            if (mimeType) {
              // Read image as binary.
              const buffer = await ops.readFile(absolutePath);
              const base64 = buffer.toString("base64");
              if (autoResizeImages) {
                // Resize image if needed before sending it back to the model.
                const resized = await resizeImage({ type: "image", data: base64, mimeType });
                if (!resized) {
                  const textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
                  content = [{ type: "text", text: textNote }];
                } else {
                  const dimensionNote = formatDimensionNote(resized);
                  let textNote = `Read image file [${resized.mimeType}]`;
                  if (dimensionNote) {
                    textNote += `\n${dimensionNote}`;
                  }
                  content = [
                    { type: "text", text: textNote },
                    { type: "image", data: resized.data, mimeType: resized.mimeType },
                  ];
                }
              } else {
                const textNote = `Read image file [${mimeType}]`;
                content = [
                  { type: "text", text: textNote },
                  { type: "image", data: base64, mimeType },
                ];
              }
            } else {
              // Read text content.
              const buffer = await ops.readFile(absolutePath);
              const textContent = buffer.toString("utf-8");
              const allLines = textContent.split("\n");
              const totalFileLines = allLines.length;
              // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
              const startLine = offset ? Math.max(0, offset - 1) : 0;
              const startLineDisplay = startLine + 1;
              // Check if offset is out of bounds.
              if (startLine >= allLines.length) {
                throw new Error(
                  `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
                );
              }
              let selectedContent: string;
              let userLimitedLines: number | undefined;
              // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
              if (limit !== undefined) {
                const endLine = Math.min(startLine + limit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
              } else {
                selectedContent = allLines.slice(startLine).join("\n");
              }
              // Apply truncation, respecting both line and byte limits.
              const truncation = truncateHead(selectedContent);
              let outputText: string;
              if (truncation.firstLineExceedsLimit) {
                // First line alone exceeds the byte limit. Point the model at a bash fallback.
                const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                details = { truncation };
              } else if (truncation.truncated) {
                // Truncation occurred. Build an actionable continuation notice.
                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;
                outputText = truncation.content;
                if (truncation.truncatedBy === "lines") {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
              } else if (
                userLimitedLines !== undefined &&
                startLine + userLimitedLines < allLines.length
              ) {
                // User-specified limit stopped early, but the file still has more content.
                const remaining = allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
              } else {
                // No truncation and no remaining user-limited content.
                outputText = truncation.content;
              }
              content = [{ type: "text", text: outputText }];
            }

            if (aborted) {
              return;
            }
            signal?.removeEventListener("abort", onAbort);
            resolve({ content, details });
          } catch (error: unknown) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(error);
            }
          }
        })();
      });
    }) as (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ReadToolResult>,
  };
}
