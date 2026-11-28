import { Code, Image, BarChart3, GitBranch, FileCode } from "lucide-react";
import { useCallback } from "react";
import { useArtifactStore, type Artifact } from "../../stores/artifact-store";
import { useUIStore } from "../../stores/ui-store";

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
      type="button"
      onClick={handleClick}
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-xs text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="max-w-[200px] truncate font-medium">{artifact.title}</span>
      <span className="text-ink-muted">{artifact.type}</span>
    </button>
  );
}
