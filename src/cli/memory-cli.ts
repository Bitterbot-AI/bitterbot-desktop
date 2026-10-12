import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;

type MemorySourceName = "memory" | "sessions" | "skills";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  if (source === "skills") {
    return "skills (*/SKILL.md across skill directories)";
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function scanSkillFiles(): Promise<SourceScan> {
  // Skills are discovered dynamically from multiple directories at sync time.
  // The CLI scan provides a minimal stub so the source appears in status output.
  return { source: "skills", totalFiles: null, issues: [] };
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
    if (source === "skills") {
      scans.push(await scanSkillFiles());
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withManager<MemoryManager>({
      getManager: () => getMemorySearchManager({ cfg, agentId, purpose: managerPurpose }),
      onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
      onCloseError: (err) =>
        defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
      close: async (manager) => {
        await manager.close?.();
      },
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

// ── PLAN-55 Phase 3: owner controls from the CLI (forget, edit, export, import) ──

type CascadeSummaryLike = {
  planHash: string;
  counts: Record<string, number>;
  factsRetired: Array<{ key: string; value: string }>;
  ownerFactsKept: Array<{ key: string; value: string }>;
  factsKeptWithOtherEvidence: Array<{ key: string; value: string }>;
  factsRelinked: Array<{ key: string; value: string }>;
  newId?: string;
};

type OwnerCliManager = {
  ownerForgetPreview: (id: string) => Promise<CascadeSummaryLike>;
  ownerForgetMemory: (
    id: string,
    opts?: { planHash?: string },
  ) => Promise<{ counts: Record<string, number>; retiredFacts: unknown[] }>;
  ownerEditPreview: (id: string, text: string) => Promise<CascadeSummaryLike>;
  ownerEditMemory: (
    id: string,
    text: string,
    opts?: { planHash?: string },
  ) => Promise<{ id: string; previousId: string; cascade: { counts: Record<string, number> } }>;
  ownerExportMemories: (outFile: string) => Promise<Record<string, unknown> & { file: string }>;
  ownerExportTo: (sink: (piece: string) => void | Promise<void>) => Promise<unknown>;
  ownerImportMemories: (
    input: unknown,
    opts?: {
      dryRun?: boolean;
      actor?: "owner" | "system";
      keepOwnerTier?: boolean;
      confirmOwnerTierGrants?: number;
    },
  ) => Promise<Record<string, unknown>>;
  ownerDatabasePath?: () => string;
};

/** y/N on an interactive terminal; false when there is no terminal to ask on. */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function ownerControls(manager: unknown): OwnerCliManager | null {
  const m = manager as Partial<OwnerCliManager>;
  return typeof m.ownerForgetPreview === "function" ? (m as OwnerCliManager) : null;
}

/** The cascade preview as lines for the terminal (no memory text). */
export function formatCascadeSummary(summary: CascadeSummaryLike): string[] {
  const c = summary.counts;
  const lines = [
    `Memories forgotten: ${c.chunks ?? 0}${c.derivedChunks ? ` (${c.derivedChunks} derived dream insight memories)` : ""}`,
    `Facts retired: ${c.factsRetired ?? 0}; owner facts kept: ${c.ownerFactsKept ?? 0}; kept on other evidence: ${summary.factsKeptWithOtherEvidence.length}${c.factsRelinked ? `; moved to the new text: ${c.factsRelinked}` : ""}`,
    `Graph links closed: ${c.edgesClosed ?? 0}; dream insights flagged: ${c.insightsFlagged ?? 0}; curiosity findings: ${c.curiosityFindings ?? 0}; preferences: ${c.preferences ?? 0}; dream-utility rows: ${c.dreamUtility ?? 0}`,
  ];
  for (const f of summary.factsRetired) lines.push(`  retire  ${f.key} = ${f.value}`);
  for (const f of summary.ownerFactsKept)
    lines.push(`  keep (yours, no evidence left)  ${f.key} = ${f.value}`);
  lines.push(`Plan: ${summary.planHash}`);
  return lines;
}

async function withOwnerControls(
  opts: { agent?: string },
  run: (m: OwnerCliManager) => Promise<void>,
): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId }),
    onMissing: (error) => {
      defaultRuntime.error(error ?? "Memory is disabled.");
      process.exitCode = 1;
    },
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      const owner = ownerControls(manager);
      if (!owner) {
        defaultRuntime.error("This memory backend has no owner controls.");
        process.exitCode = 1;
        return;
      }
      try {
        await run(owner);
      } catch (err) {
        defaultRuntime.error(formatErrorMessage(err));
        process.exitCode = 1;
      }
    },
  });
}

function registerOwnerMemoryCommands(memory: Command) {
  memory
    .command("forget")
    .description("Forget a memory and what rests only on it (shows the cascade first)")
    .argument("<id>", "Memory id (from the Memory page or memory.list)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--preview", "Show what would change and stop", false)
    .option("--yes", "Apply without asking again", false)
    .option("--json", "Print JSON")
    .action(
      async (
        id: string,
        opts: { agent?: string; preview?: boolean; yes?: boolean; json?: boolean },
      ) => {
        await withOwnerControls(opts, async (m) => {
          const preview = await m.ownerForgetPreview(id);
          if (opts.preview || !opts.yes) {
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ preview }, null, 2));
            } else {
              defaultRuntime.log(formatCascadeSummary(preview).join("\n"));
              if (!opts.preview) {
                defaultRuntime.log("Nothing changed. Re-run with --yes to forget it.");
              }
            }
            return;
          }
          const result = await m.ownerForgetMemory(id, { planHash: preview.planHash });
          defaultRuntime.log(
            opts.json
              ? JSON.stringify(result, null, 2)
              : `Forgot ${id}: ${result.counts.chunks ?? 0} memories, ${result.retiredFacts.length} fact(s) retired.`,
          );
        });
      },
    );

  memory
    .command("edit")
    .description("Replace a memory's text (the old one is forgotten with its cascade)")
    .argument("<id>", "Memory id")
    .argument("<text>", "The new text")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--preview", "Show what would change and stop", false)
    .option("--yes", "Apply without asking again", false)
    .option("--json", "Print JSON")
    .action(
      async (
        id: string,
        text: string,
        opts: { agent?: string; preview?: boolean; yes?: boolean; json?: boolean },
      ) => {
        await withOwnerControls(opts, async (m) => {
          const preview = await m.ownerEditPreview(id, text);
          if (opts.preview || !opts.yes) {
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ preview }, null, 2));
            } else {
              defaultRuntime.log(formatCascadeSummary(preview).join("\n"));
              if (!opts.preview) {
                defaultRuntime.log("Nothing changed. Re-run with --yes to replace it.");
              }
            }
            return;
          }
          const result = await m.ownerEditMemory(id, text, { planHash: preview.planHash });
          defaultRuntime.log(
            opts.json
              ? JSON.stringify(result, null, 2)
              : `Replaced ${result.previousId} with ${result.id}.`,
          );
        });
      },
    );

  memory
    .command("export")
    .description("Export everything the agent remembers (JSON, version 2)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--out <file>", "Output file, or - for stdout (default: ~/.bitterbot/exports/)")
    .option("--format <format>", "Export format (v2)", "v2")
    .option("--json", "Print the result as JSON")
    .action(async (opts: { agent?: string; out?: string; format?: string; json?: boolean }) => {
      if (opts.format && opts.format !== "v2" && opts.format !== "2") {
        defaultRuntime.error(
          `Unknown format "${opts.format}"; only v2 is written (v1 readers can read it).`,
        );
        process.exitCode = 1;
        return;
      }
      await withOwnerControls(opts, async (m) => {
        if (opts.out === "-") {
          await m.ownerExportTo((piece) => {
            process.stdout.write(piece);
          });
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = opts.out
          ? path.resolve(opts.out)
          : path.join(resolveStateDir(process.env, os.homedir), "exports", `memory-${stamp}.json`);
        const result = await m.ownerExportMemories(file);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(
          `Exported to ${shortenHomePath(result.file)} (${String(result.memories)} memories, ${String(result.facts)} facts, ${String(result.redactions)} redaction(s)).`,
        );
        const dbPath = m.ownerDatabasePath?.();
        if (dbPath) {
          defaultRuntime.log(`The raw database is ${shortenHomePath(dbPath)}.`);
        }
      });
    });

  memory
    .command("import")
    .description("Restore a memory export (v1 or v2) as the owner")
    .argument("<file>", "Export file")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--dry-run", "Count what would be restored, change nothing", false)
    .option(
      "--keep-owner-tier",
      "Keep facts that were owner-tier in the export at the owner tier (asks first)",
      false,
    )
    .option("--yes", "With --keep-owner-tier: do not ask", false)
    .option("--json", "Print JSON")
    .action(
      async (
        file: string,
        opts: {
          agent?: string;
          dryRun?: boolean;
          keepOwnerTier?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const { MAX_IMPORT_BYTES, parseMemoryExport } = await import("../memory/memory-import.js");
        let raw: string;
        try {
          const stat = await fs.stat(file);
          if (stat.size > MAX_IMPORT_BYTES) {
            defaultRuntime.error(
              `${file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; imports are capped at ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
            );
            process.exitCode = 1;
            return;
          }
          raw = await fs.readFile(file, "utf8");
        } catch (err) {
          defaultRuntime.error(`Cannot read ${file}: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
          return;
        }
        await withOwnerControls(opts, async (m) => {
          const input = parseMemoryExport(raw);
          const keepOwnerTier = Boolean(opts.keepOwnerTier);
          let confirmOwnerTierGrants: number | undefined;
          if (keepOwnerTier && !opts.dryRun) {
            // Rule C: count the grants with a dry run, say what they mean, and
            // apply exactly that count.
            const dry = (await m.ownerImportMemories(input, {
              dryRun: true,
              actor: "owner",
              keepOwnerTier: true,
            })) as { ownerTierGrants?: number };
            const grants = dry.ownerTierGrants ?? 0;
            if (grants > 0) {
              const warning = `This will give ${grants} facts owner authority (they will override the agent and win every conflict).`;
              defaultRuntime.log(warning);
              if (!opts.yes && !(await askYesNo("Continue?"))) {
                defaultRuntime.error(
                  process.stdin.isTTY
                    ? "Import cancelled; nothing changed."
                    : "Refusing to grant owner authority without a terminal to confirm on; re-run with --yes.",
                );
                process.exitCode = 1;
                return;
              }
            }
            confirmOwnerTierGrants = grants;
          }
          const result = await m.ownerImportMemories(input, {
            dryRun: Boolean(opts.dryRun),
            actor: "owner",
            keepOwnerTier,
            confirmOwnerTierGrants,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const r = result as {
            dryRun: boolean;
            memories: Record<string, number>;
            facts: Record<string, number>;
            preferences: Record<string, number>;
            ownerTierGrants?: number;
            ownerFactsUnconfirmed?: Array<{ key: string; value: string; scope: string }>;
          };
          const fmt = (t: Record<string, number>) =>
            Object.entries(t)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "nothing";
          defaultRuntime.log(
            [
              r.dryRun ? "Dry run, nothing written." : "Imported.",
              `Memories: ${fmt(r.memories)}`,
              `Facts: ${fmt(r.facts)}`,
              `Preferences: ${fmt(r.preferences)}`,
              `Owner-tier grants: ${r.ownerTierGrants ?? 0}`,
              ...((r.ownerFactsUnconfirmed ?? []).length > 0
                ? [
                    `Imported below your tier (were yours in the export; pin one to confirm it):`,
                    ...(r.ownerFactsUnconfirmed ?? []).map(
                      (f) =>
                        `  ${f.key} = ${f.value}${f.scope === "global" ? "" : ` (${f.scope})`}`,
                    ),
                  ]
                : []),
            ].join("\n"),
          );
        });
      },
    );
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Memory search tools and owner controls")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.bitterbot.ai/cli/memory")}\n`,
    );

  registerOwnerMemoryCommands(memory);

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: async (manager) => {
            await manager.close?.();
          },
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("backfill-embeddings")
    .description(
      "Embed + index crystals stored with placeholder embeddings (fact_*, notes, briefs)",
    )
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--limit <n>", "Max chunks embedded per batch", (value: string) => Number(value))
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { limit?: number }) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: async (manager) => {
            await manager.close?.();
          },
          run: async (manager) => {
            const backfill = (
              manager as {
                backfillPendingEmbeddings?: (opts?: {
                  limit?: number;
                }) => Promise<{ embedded: number; remaining: number }>;
              }
            ).backfillPendingEmbeddings;
            if (typeof backfill !== "function") {
              defaultRuntime.log("Memory backend does not support embedding backfill.");
              return;
            }
            const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined;
            let total = 0;
            try {
              for (;;) {
                const { embedded, remaining } = await backfill.call(manager, { limit });
                total += embedded;
                if (embedded === 0) {
                  break;
                }
                defaultRuntime.log(`Embedded ${total} crystal(s) so far, ${remaining} remaining…`);
              }
              defaultRuntime.log(
                `Embedding backfill complete (${agentId}): embedded ${total} crystal(s).`,
              );
            } catch (err) {
              defaultRuntime.error(
                `Embedding backfill failed (${agentId}): ${formatErrorMessage(err)}`,
              );
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: async (manager) => {
            await manager.close?.();
          },
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );
}
