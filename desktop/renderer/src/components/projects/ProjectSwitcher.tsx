import { useProjectsStore } from "../../stores/projects-store";
import { FolderKanban, ChevronDown } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";

/**
 * Compact dropdown for switching the active project.
 * Intended for placement in the chat header area.
 */
export function ProjectSwitcher() {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setActiveProjectId = useProjectsStore((s) => s.setActiveProjectId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveProjectId(id);
      setOpen(false);
    },
    [setActiveProjectId],
  );

  if (projects.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors",
          activeProject
            ? "text-purple-400 bg-purple-500/10 border border-purple-500/20"
            : "text-muted-foreground hover:bg-accent",
        )}
      >
        <FolderKanban className="w-3 h-3" />
        <span className="truncate max-w-[120px]">
          {activeProject ? activeProject.name : "No project"}
        </span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 rounded-lg bg-card border border-border/30 shadow-lg z-50 py-1">
          <button
            onClick={() => handleSelect(null)}
            className={cn(
              "w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors",
              !activeProjectId && "text-purple-400",
            )}
          >
            No project
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className={cn(
                "w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors truncate",
                activeProjectId === p.id && "text-purple-400",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
