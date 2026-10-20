/**
 * PLAN-52 Phase 5: the read, write and edit file tools, owned by this repo.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/tools/`. Each file in this directory lists its differences from the
 * original in its header.
 *
 * Differences from pi's `core/tools/index.ts`:
 *
 * 1. Only the three file tools the gateway builds are here. pi's bash, grep,
 *    find and ls tools are not ported: the gateway has its own exec and
 *    process tools and never kept pi's bash tool, and it never used grep,
 *    find or ls.
 * 2. `createCodingTools` (read, bash, edit, write) is not ported. Its one
 *    caller only read the tool names from it, to rebuild read, edit and write
 *    per workspace in that order. `CODING_FILE_TOOL_NAMES` carries that order.
 * 3. The `create*ToolDefinition` factories, `createTool`, `createAllTools`,
 *    `createReadOnlyTools` and `allToolNames` are not ported.
 */
export {
  createEditTool,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
  createReadTool,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
} from "./read.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
} from "./truncate.js";
export {
  createWriteTool,
  type WriteOperations,
  type WriteToolInput,
  type WriteToolOptions,
} from "./write.js";

/**
 * The file tools in the order pi's `createCodingTools` returned them (with its
 * bash tool, which the gateway always replaced by exec, removed). The order
 * decides the order of the tool definitions sent to the model.
 */
export const CODING_FILE_TOOL_NAMES = ["read", "edit", "write"] as const;
