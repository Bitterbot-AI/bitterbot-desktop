import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "../../lib/utils";

interface ArtifactRendererProps {
  artifactId: string;
  /** Base URL of the canvas host, e.g. "http://127.0.0.1:18793" */
  canvasBaseUrl: string;
  className?: string;
}

/**
 * Sandboxed iframe wrapper for rendering artifacts.
 * The iframe uses `sandbox="allow-scripts allow-forms"` (no allow-same-origin)
 * to prevent the artifact from accessing the parent window.
 */
export function ArtifactRenderer({ artifactId, canvasBaseUrl, className }: ArtifactRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const src = `${canvasBaseUrl}/__bitterbot__/canvas/artifacts/${encodeURIComponent(artifactId)}.html`;

  const handleMessage = useCallback((event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    const { type } = event.data;
    if (type === "artifact-error") {
      setError(`${event.data.error} (line ${event.data.line ?? "?"})`);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const handleLoad = useCallback(() => {
    setLoading(false);
    setError(null);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError("Failed to load artifact");
  }, []);

  // Reset state when artifact changes
  useEffect(() => {
    setLoading(true);
    setError(null);
  }, [artifactId]);

  return (
    <div className={cn("relative w-full h-full bg-black/90 rounded-lg overflow-hidden", className)}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/60">
          <div className="flex items-center gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading artifact...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-2 left-2 right-2 z-20 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-400 truncate">{error}</span>
        </div>
      )}

      <iframe
        ref={iframeRef}
        src={src}
        sandbox="allow-scripts allow-forms allow-same-origin"
        onLoad={handleLoad}
        onError={handleError}
        className="w-full h-full border-0"
        title={`Artifact: ${artifactId}`}
      />
    </div>
  );
}
