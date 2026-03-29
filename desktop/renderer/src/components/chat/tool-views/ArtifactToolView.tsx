import type { ToolViewProps } from "./ToolViewRegistry";
import { useArtifactStore } from "../../../stores/artifact-store";
import { useUIStore } from "../../../stores/ui-store";
import { Code, ExternalLink } from "lucide-react";
import { useCallback } from "react";

/**
 * Tool view for the create_artifact tool call.
 * Shows a preview card and a button to open the full artifact in the panel.
 */
export function ArtifactToolView({ toolCall }: ToolViewProps) {
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);

  const args = toolCall.args as Record<string, unknown> | undefined;
  const title = typeof args?.title === "string" ? args.title : "Artifact";
  const type = typeof args?.type === "string" ? args.type : "html";
  const identifier = typeof args?.identifier === "string" ? args.identifier : "";

  const isRunning = toolCall.status === "running";

  const handleOpenArtifact = useCallback(() => {
    if (identifier) {
      openArtifact(identifier);
      setToolPanelOpen(true);
    }
  }, [identifier, openArtifact, setToolPanelOpen]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
        <Code className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-medium text-zinc-300">
          Create Artifact
        </span>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Artifact info */}
        <div className="rounded-lg bg-zinc-900/40 border border-zinc-800/30 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{title}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 px-1.5 py-0.5 rounded bg-zinc-800/50">
              {type}
            </span>
          </div>

          {identifier && (
            <div className="text-xs text-muted-foreground/60 font-mono">
              id: {identifier}
            </div>
          )}
        </div>

        {isRunning ? (
          <div className="flex items-center gap-2 text-zinc-500 py-4">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" />
            <span className="text-sm">Creating artifact...</span>
          </div>
        ) : (
          <button
            onClick={handleOpenArtifact}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-colors text-sm"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Artifact Viewer
          </button>
        )}
      </div>
    </div>
  );
}
