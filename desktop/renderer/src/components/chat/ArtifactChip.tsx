import { useArtifactStore, type Artifact } from "../../stores/artifact-store";
import { useUIStore } from "../../stores/ui-store";
import { Code, Image, BarChart3, GitBranch, FileCode } from "lucide-react";
import { cn } from "../../lib/utils";
import { useCallback } from "react";

interface ArtifactChipProps {
  artifactId: string;
}

function getArtifactIcon(type: string) {
  switch (type) {
    case "react":
      return Code;
    case "svg":
      return Image;
    case "mermaid":
      return GitBranch;
    case "javascript":
      return FileCode;
    default:
      return BarChart3;
  }
}

/**
 * Inline chip displayed in chat messages when an artifact is created or updated.
 * Clicking it opens the artifact in the right panel.
 */
export function ArtifactChip({ artifactId }: ArtifactChipProps) {
  const artifact = useArtifactStore((s) => s.artifacts.get(artifactId));
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);

  const handleClick = useCallback(() => {
    openArtifact(artifactId);
    setToolPanelOpen(true);
  }, [artifactId, openArtifact, setToolPanelOpen]);

  if (!artifact) return null;

  const Icon = getArtifactIcon(artifact.type);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium",
        "border transition-all cursor-pointer hover:scale-[1.02]",
        "bg-blue-500/5 border-blue-500/20 text-blue-400 hover:bg-blue-500/10",
      )}
    >
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate max-w-[200px]">{artifact.title}</span>
      <span className="text-muted-foreground/40">|</span>
      <span className="text-muted-foreground/70 text-[10px] font-normal uppercase">
        {artifact.type}
      </span>
    </button>
  );
}
