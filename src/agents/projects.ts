import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { ensureDir } from "../utils.js";

export interface ProjectKnowledgeBase {
  files: ProjectKBFile[];
  autoRag: boolean;
  ragThresholdTokens: number;
}

export interface ProjectKBFile {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  addedAt: number;
}

export interface Project {
  id: string;
  name: string;
  systemPrompt: string;
  knowledgeBase: ProjectKnowledgeBase;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  systemPrompt?: string;
  knowledgeBase?: {
    files?: Array<{ id: string; name: string; path: string; sizeBytes: number; addedAt: number }>;
    autoRag?: boolean;
    ragThresholdTokens?: number;
  };
  createdAt?: number;
  updatedAt?: number;
}

function resolveProjectsDir(): string {
  return path.join(resolveStateDir(), "projects");
}

function resolveProjectDir(projectId: string): string {
  return path.join(resolveProjectsDir(), projectId);
}

function resolveProjectKnowledgeDir(projectId: string): string {
  return path.join(resolveProjectDir(projectId), "knowledge");
}

function readProjectsFromConfig(): ProjectConfig[] {
  const cfg = loadConfig();
  const raw = (cfg as Record<string, unknown>).projects as { list?: ProjectConfig[] } | undefined;
  return Array.isArray(raw?.list) ? raw.list : [];
}

async function writeProjectsToConfig(projects: ProjectConfig[]): Promise<void> {
  const cfg = loadConfig();
  (cfg as Record<string, unknown>).projects = { list: projects };
  await writeConfigFile(cfg);
}

function toProject(pc: ProjectConfig): Project {
  return {
    id: pc.id,
    name: pc.name,
    systemPrompt: pc.systemPrompt ?? "",
    knowledgeBase: {
      files: pc.knowledgeBase?.files ?? [],
      autoRag: pc.knowledgeBase?.autoRag ?? true,
      ragThresholdTokens: pc.knowledgeBase?.ragThresholdTokens ?? 100_000,
    },
    createdAt: pc.createdAt ?? Date.now(),
    updatedAt: pc.updatedAt ?? Date.now(),
  };
}

function toConfig(p: Project): ProjectConfig {
  return {
    id: p.id,
    name: p.name,
    systemPrompt: p.systemPrompt || undefined,
    knowledgeBase: {
      files: p.knowledgeBase.files,
      autoRag: p.knowledgeBase.autoRag,
      ragThresholdTokens: p.knowledgeBase.ragThresholdTokens,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function listProjects(): Project[] {
  return readProjectsFromConfig().map(toProject);
}

export function getProject(projectId: string): Project | undefined {
  const configs = readProjectsFromConfig();
  const found = configs.find((p) => p.id === projectId);
  return found ? toProject(found) : undefined;
}

export async function createProject(params: {
  name: string;
  systemPrompt?: string;
}): Promise<Project> {
  const id = crypto.randomUUID().slice(0, 8);
  const now = Date.now();
  const project: Project = {
    id,
    name: params.name,
    systemPrompt: params.systemPrompt ?? "",
    knowledgeBase: {
      files: [],
      autoRag: true,
      ragThresholdTokens: 100_000,
    },
    createdAt: now,
    updatedAt: now,
  };
  const configs = readProjectsFromConfig();
  configs.push(toConfig(project));
  await writeProjectsToConfig(configs);
  return project;
}

export async function updateProject(
  projectId: string,
  updates: Partial<Pick<Project, "name" | "systemPrompt">>,
): Promise<Project | undefined> {
  const configs = readProjectsFromConfig();
  const idx = configs.findIndex((p) => p.id === projectId);
  if (idx < 0) return undefined;

  const existing = toProject(configs[idx]);
  if (updates.name !== undefined) existing.name = updates.name;
  if (updates.systemPrompt !== undefined) existing.systemPrompt = updates.systemPrompt;
  existing.updatedAt = Date.now();

  configs[idx] = toConfig(existing);
  await writeProjectsToConfig(configs);
  return existing;
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const configs = readProjectsFromConfig();
  const idx = configs.findIndex((p) => p.id === projectId);
  if (idx < 0) return false;

  configs.splice(idx, 1);
  await writeProjectsToConfig(configs);
  return true;
}

export async function addProjectFile(
  projectId: string,
  fileName: string,
  content: Buffer,
): Promise<ProjectKBFile | undefined> {
  const configs = readProjectsFromConfig();
  const idx = configs.findIndex((p) => p.id === projectId);
  if (idx < 0) return undefined;

  const kbDir = resolveProjectKnowledgeDir(projectId);
  await ensureDir(kbDir);

  const fileId = crypto.randomUUID().slice(0, 8);
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(kbDir, `${fileId}_${safeName}`);

  await fs.writeFile(filePath, content);

  const file: ProjectKBFile = {
    id: fileId,
    name: fileName,
    path: filePath,
    sizeBytes: content.length,
    addedAt: Date.now(),
  };

  const existing = toProject(configs[idx]);
  existing.knowledgeBase.files.push(file);
  existing.updatedAt = Date.now();
  configs[idx] = toConfig(existing);
  await writeProjectsToConfig(configs);

  return file;
}

export function listProjectFiles(projectId: string): ProjectKBFile[] {
  const project = getProject(projectId);
  return project?.knowledgeBase.files ?? [];
}

export async function deleteProjectFile(projectId: string, fileId: string): Promise<boolean> {
  const configs = readProjectsFromConfig();
  const idx = configs.findIndex((p) => p.id === projectId);
  if (idx < 0) return false;

  const existing = toProject(configs[idx]);
  const fileIdx = existing.knowledgeBase.files.findIndex((f) => f.id === fileId);
  if (fileIdx < 0) return false;

  const [removed] = existing.knowledgeBase.files.splice(fileIdx, 1);
  existing.updatedAt = Date.now();
  configs[idx] = toConfig(existing);
  await writeProjectsToConfig(configs);

  // Best effort: delete the actual file
  try {
    await fs.unlink(removed.path);
  } catch {
    // ignore
  }

  return true;
}
