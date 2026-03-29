import { useEffect, useState, useCallback } from "react";
import { useProjectsStore, type Project } from "../../stores/projects-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { cn } from "../../lib/utils";
import {
  FolderKanban,
  Plus,
  Trash2,
  FileText,
  Upload,
  X,
  ChevronRight,
  Database,
} from "lucide-react";

export function ProjectsView() {
  const projects = useProjectsStore((s) => s.projects);
  const loading = useProjectsStore((s) => s.loading);
  const error = useProjectsStore((s) => s.error);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);
  const createProject = useProjectsStore((s) => s.createProject);
  const deleteProject = useProjectsStore((s) => s.deleteProject);
  const status = useGatewayStore((s) => s.status);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (status === "connected") {
      fetchProjects();
    }
  }, [status, fetchProjects]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const project = await createProject(newName.trim());
    if (project) {
      setSelectedId(project.id);
      setShowCreate(false);
      setNewName("");
    }
  }, [newName, createProject]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteProject(id);
      if (selectedId === id) setSelectedId(null);
    },
    [deleteProject, selectedId],
  );

  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full">
      {/* Project list sidebar */}
      <div className="w-64 border-r border-border/30 flex flex-col">
        <div className="p-3 border-b border-border/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-semibold">Projects</span>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="p-2 border-b border-border/20 flex items-center gap-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowCreate(false);
              }}
              placeholder="Project name..."
              className="flex-1 text-xs bg-transparent border border-border/30 rounded px-2 py-1 outline-none focus:border-purple-500/50"
            />
            <button onClick={handleCreate} className="text-xs text-purple-400 hover:text-purple-300 px-1">
              Add
            </button>
            <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Project list */}
        <div className="flex-1 overflow-auto">
          {loading && projects.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading...</div>
          ) : projects.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground">
              <FolderKanban className="w-6 h-6 mx-auto mb-2 opacity-50" />
              <p className="text-xs">No projects yet</p>
            </div>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setSelectedId(project.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50",
                  selectedId === project.id && "bg-accent",
                )}
              >
                <FolderKanban className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <span className="flex-1 truncate">{project.name}</span>
                <span className="text-[10px] text-muted-foreground/50">
                  {project.knowledgeBase.files.length} files
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground/30" />
              </button>
            ))
          )}
        </div>
      </div>

      {/* Project detail */}
      <div className="flex-1 overflow-auto">
        {selected ? (
          <ProjectDetail project={selected} onDelete={handleDelete} />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <FolderKanban className="w-8 h-8 mx-auto opacity-50" />
              <p className="text-sm">Select a project</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="absolute bottom-4 left-4 right-4 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: (id: string) => void;
}) {
  const updateProject = useProjectsStore((s) => s.updateProject);
  const uploadFile = useProjectsStore((s) => s.uploadFile);
  const deleteFile = useProjectsStore((s) => s.deleteFile);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(project.systemPrompt);

  useEffect(() => {
    setPromptValue(project.systemPrompt);
    setEditingPrompt(false);
  }, [project.id, project.systemPrompt]);

  const handleSavePrompt = useCallback(async () => {
    await updateProject(project.id, { systemPrompt: promptValue });
    setEditingPrompt(false);
  }, [project.id, promptValue, updateProject]);

  const handleFileUpload = useCallback(async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files) return;
      for (const file of input.files) {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(",")[1] ?? "";
          await uploadFile(project.id, file.name, base64);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }, [project.id, uploadFile]);

  const totalKB = project.knowledgeBase.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const estimatedTokens = Math.ceil(totalKB / 4);
  const ragActive = project.knowledgeBase.autoRag && estimatedTokens >= project.knowledgeBase.ragThresholdTokens;

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{project.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Created {new Date(project.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button
          onClick={() => onDelete(project.id)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 className="w-3 h-3" />
          Delete
        </button>
      </div>

      {/* System prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            System Instructions
          </span>
          {!editingPrompt && (
            <button
              onClick={() => setEditingPrompt(true)}
              className="text-[10px] text-purple-400 hover:text-purple-300"
            >
              Edit
            </button>
          )}
        </div>
        {editingPrompt ? (
          <div className="space-y-2">
            <textarea
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              rows={6}
              className="w-full text-xs bg-zinc-900/40 border border-border/30 rounded-lg p-2.5 outline-none focus:border-purple-500/50 resize-y"
              placeholder="Custom system instructions for this project..."
            />
            <div className="flex gap-2">
              <button
                onClick={handleSavePrompt}
                className="px-3 py-1 text-xs rounded-md bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setPromptValue(project.systemPrompt);
                  setEditingPrompt(false);
                }}
                className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:bg-accent transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground bg-zinc-900/20 rounded-lg p-2.5 border border-border/20 min-h-[40px]">
            {project.systemPrompt || <span className="italic opacity-50">No custom instructions</span>}
          </div>
        )}
      </div>

      {/* Knowledge base */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Knowledge Base
            </span>
            {ragActive ? (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Database className="w-2.5 h-2.5" />
                RAG Active
              </span>
            ) : project.knowledgeBase.files.length > 0 ? (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Full Context
              </span>
            ) : null}
          </div>
          <button
            onClick={handleFileUpload}
            className="flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300"
          >
            <Upload className="w-3 h-3" />
            Upload
          </button>
        </div>

        {project.knowledgeBase.files.length === 0 ? (
          <div className="text-center py-6 bg-zinc-900/20 rounded-lg border border-dashed border-border/20">
            <FileText className="w-6 h-6 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground/50">
              Drop files or click Upload to add knowledge
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {project.knowledgeBase.files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-zinc-900/20 border border-border/10"
              >
                <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="text-xs flex-1 truncate">{file.name}</span>
                <span className="text-[10px] text-muted-foreground/40">
                  {formatFileSize(file.sizeBytes)}
                </span>
                <button
                  onClick={() => deleteFile(project.id, file.id)}
                  className="text-muted-foreground/40 hover:text-red-400 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="text-[10px] text-muted-foreground/40 pt-1">
              {project.knowledgeBase.files.length} file{project.knowledgeBase.files.length !== 1 ? "s" : ""} ·{" "}
              {formatFileSize(totalKB)} · ~{estimatedTokens.toLocaleString()} tokens
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
