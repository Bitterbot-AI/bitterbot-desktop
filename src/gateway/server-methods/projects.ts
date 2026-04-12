import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { buildProjectContext } from "../../agents/project-rag.js";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addProjectFile,
  listProjectFiles,
  deleteProjectFile,
} from "../../agents/projects.js";

const projectsList: GatewayRequestHandler = async ({ respond }) => {
  const projects = listProjects();
  respond(true, { projects });
};

const projectsGet: GatewayRequestHandler = async ({ params, respond }) => {
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
    return;
  }
  const project = getProject(id);
  if (!project) {
    respond(false, undefined, { code: "NOT_FOUND", message: "project not found" });
    return;
  }
  respond(true, { project });
};

const projectsCreate: GatewayRequestHandler = async ({ params, respond }) => {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "name required" });
    return;
  }
  const systemPrompt = typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
  const project = createProject({ name, systemPrompt });
  respond(true, { project });
};

const projectsUpdate: GatewayRequestHandler = async ({ params, respond }) => {
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (typeof params.name === "string") updates.name = params.name;
  if (typeof params.systemPrompt === "string") updates.systemPrompt = params.systemPrompt;
  const project = updateProject(id, updates as { name?: string; systemPrompt?: string });
  if (!project) {
    respond(false, undefined, { code: "NOT_FOUND", message: "project not found" });
    return;
  }
  respond(true, { project });
};

const projectsDelete: GatewayRequestHandler = async ({ params, respond }) => {
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
    return;
  }
  const ok = deleteProject(id);
  if (!ok) {
    respond(false, undefined, { code: "NOT_FOUND", message: "project not found" });
    return;
  }
  respond(true, { ok: true });
};

const projectsFilesList: GatewayRequestHandler = async ({ params, respond }) => {
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  if (!projectId) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "projectId required" });
    return;
  }
  const files = listProjectFiles(projectId);
  respond(true, { files });
};

const projectsFilesUpload: GatewayRequestHandler = async ({ params, respond }) => {
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  const fileName = typeof params.fileName === "string" ? params.fileName : "";
  const contentBase64 = typeof params.content === "string" ? params.content : "";

  if (!projectId || !fileName || !contentBase64) {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "projectId, fileName, and content (base64) required",
    });
    return;
  }

  const content = Buffer.from(contentBase64, "base64");
  const file = await addProjectFile(projectId, fileName, content);
  if (!file) {
    respond(false, undefined, { code: "NOT_FOUND", message: "project not found" });
    return;
  }
  respond(true, { file });
};

const projectsFilesDelete: GatewayRequestHandler = async ({ params, respond }) => {
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  const fileId = typeof params.fileId === "string" ? params.fileId : "";

  if (!projectId || !fileId) {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "projectId and fileId required",
    });
    return;
  }

  const ok = await deleteProjectFile(projectId, fileId);
  if (!ok) {
    respond(false, undefined, { code: "NOT_FOUND", message: "file not found" });
    return;
  }
  respond(true, { ok: true });
};

const projectsContext: GatewayRequestHandler = async ({ params, respond }) => {
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  if (!projectId) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "projectId required" });
    return;
  }
  const context = await buildProjectContext(projectId);
  if (!context) {
    respond(false, undefined, { code: "NOT_FOUND", message: "project not found" });
    return;
  }
  respond(true, { context });
};

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": projectsList,
  "projects.get": projectsGet,
  "projects.create": projectsCreate,
  "projects.update": projectsUpdate,
  "projects.delete": projectsDelete,
  "projects.files.list": projectsFilesList,
  "projects.files.upload": projectsFilesUpload,
  "projects.files.delete": projectsFilesDelete,
  "projects.context": projectsContext,
};
