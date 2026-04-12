import { Code, Copy, Download, ExternalLink, X } from "lucide-react";
import { useCallback, useMemo } from "react";
import { cn } from "../../lib/utils";
import { useArtifactStore } from "../../stores/artifact-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { ArtifactRenderer } from "./ArtifactRenderer";

interface ArtifactPanelProps {
  onClose?: () => void;
}

/**
 * Right panel artifact viewer with iframe, title bar, and actions.
 */
export function ArtifactPanel({ onClose }: ArtifactPanelProps) {
  const activeArtifactId = useArtifactStore((s) => s.activeArtifactId);
  const artifacts = useArtifactStore((s) => s.artifacts);
  const hello = useGatewayStore((s) => s.hello);

  const artifact = activeArtifactId ? artifacts.get(activeArtifactId) : undefined;

  // Derive canvas host URL from gateway connection
  const canvasBaseUrl = useMemo(() => {
    // When the UI is served from localhost, reuse the current origin so the iframe
    // loads same-origin (avoids cross-origin iframe issues).
    if (window.location.protocol === "http:" && window.location.hostname === "localhost") {
      return window.location.origin;
    }
    // The canvas host runs on the same host/port as the gateway
    const gwUrl = useGatewayStore.getState().client?.url;
    if (gwUrl) {
      try {
        const parsed = new URL(gwUrl.replace("ws://", "http://").replace("wss://", "https://"));
        return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
      } catch {
        // fallback
      }
    }
    // Fall back to env-configured gateway URL or default gateway port
    const envUrl = import.meta.env.VITE_GATEWAY_URL;
    if (envUrl) {
      try {
        const parsed = new URL(envUrl.replace("ws://", "http://").replace("wss://", "https://"));
        return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
      } catch {
        // fallback
      }
    }
    return "http://127.0.0.1:19001";
  }, [hello?.ts]);

  const artifactUrl = activeArtifactId
    ? `${canvasBaseUrl}/__bitterbot__/canvas/artifacts/${encodeURIComponent(activeArtifactId)}.html`
    : null;

  const handleCopyLink = useCallback(() => {
    if (artifactUrl) {
      navigator.clipboard.writeText(artifactUrl).catch(() => {});
    }
  }, [artifactUrl]);

  const handleOpenExternal = useCallback(() => {
    if (artifactUrl) {
      window.open(artifactUrl, "_blank");
    }
  }, [artifactUrl]);

  const handleDownload = useCallback(() => {
    if (artifactUrl) {
      const a = document.createElement("a");
      a.href = artifactUrl;
      a.download = `${activeArtifactId ?? "artifact"}.html`;
      a.click();
    }
  }, [artifactUrl, activeArtifactId]);

  if (!activeArtifactId || !artifact) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2 text-muted-foreground">
          <Code className="w-8 h-8 mx-auto opacity-50" />
          <p className="text-sm">No artifact selected</p>
          <p className="text-xs">
            Artifacts will appear here when the agent creates interactive content.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 flex-shrink-0">
        <Code className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {artifact.title}
        </span>
        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
          {artifact.type}
        </span>
        {artifact.version > 1 && (
          <span className="text-[10px] text-muted-foreground/50">v{artifact.version}</span>
        )}
      </div>

      {/* Artifact iframe */}
      <div className="flex-1 overflow-hidden">
        <ArtifactRenderer artifactId={activeArtifactId} canvasBaseUrl={canvasBaseUrl} />
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border/20 flex-shrink-0">
        <ActionButton icon={Copy} label="Copy link" onClick={handleCopyLink} />
        <ActionButton icon={ExternalLink} label="Open in browser" onClick={handleOpenExternal} />
        <ActionButton icon={Download} label="Download" onClick={handleDownload} />
      </div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] text-muted-foreground",
        "hover:bg-accent hover:text-foreground transition-colors",
      )}
    >
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </button>
  );
}
