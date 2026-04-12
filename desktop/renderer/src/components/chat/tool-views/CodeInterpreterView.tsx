import { Play, Terminal, Image, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { onCodeExecResult, type CodeExecResult } from "../../../lib/code-exec-manager";
import { cn } from "../../../lib/utils";
import { useArtifactStore } from "../../../stores/artifact-store";
import { useGatewayStore } from "../../../stores/gateway-store";
import { useUIStore } from "../../../stores/ui-store";

/**
 * Tool view for the code_interpreter tool call.
 * Shows code, execution status, stdout/stderr, and generated images.
 */
export function CodeInterpreterView({ toolCall }: ToolViewProps) {
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);
  const setPanelMode = useArtifactStore((s) => s.setPanelMode);
  const outputRef = useRef<HTMLPreElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [execResult, setExecResult] = useState<CodeExecResult | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const args = toolCall.args as Record<string, unknown> | undefined;
  const language = typeof args?.language === "string" ? args.language : "javascript";
  const code = typeof args?.code === "string" ? args.code : "";

  const isRunning = toolCall.status === "running";
  const isCompleted = toolCall.status === "completed";
  const isError = toolCall.status === "error";

  // Parse execId from tool result
  const execId = (() => {
    if (!toolCall.result) return null;
    try {
      const parsed = JSON.parse(toolCall.result);
      return typeof parsed.execId === "string" ? parsed.execId : null;
    } catch {
      return null;
    }
  })();

  // Derive the canvas host base URL from gateway connection (same pattern as ArtifactPanel)
  const hello = useGatewayStore((s) => s.hello);
  const canvasBaseUrl = (() => {
    if (!hello?.ts) return null;
    const gwUrl = useGatewayStore.getState().client?.url;
    if (!gwUrl) return null;
    try {
      const parsed = new URL(gwUrl.replace("ws://", "http://").replace("wss://", "https://"));
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port}/__bitterbot__/canvas`;
    } catch {
      return null;
    }
  })();

  // Listen for execution results
  useEffect(() => {
    if (!execId) return;
    const cleanup = onCodeExecResult(execId, (result) => {
      setExecResult(result);
    });
    return cleanup;
  }, [execId]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [execResult]);

  // Build iframe URL for code execution
  const iframeSrc = execId && canvasBaseUrl ? `${canvasBaseUrl}/code-exec/${execId}.html` : null;

  const hasOutput =
    execResult && (execResult.stdout || execResult.stderr || execResult.images.length > 0);
  const hasImages = execResult && execResult.images.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
        <Terminal className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-xs font-medium text-zinc-300">Code Interpreter</span>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
            language === "python"
              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
              : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
          )}
        >
          {language}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && !execResult && (
            <>
              <Loader2 className="w-3 h-3 text-emerald-400 animate-spin" />
              <span className="text-[10px] text-emerald-400">Running</span>
            </>
          )}
          {execResult && !execResult.error && (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              <span className="text-[10px] text-emerald-400">Completed</span>
            </>
          )}
          {(isError || execResult?.error) && (
            <>
              <AlertCircle className="w-3 h-3 text-red-400" />
              <span className="text-[10px] text-red-400">Error</span>
            </>
          )}
        </div>
      </div>

      {/* Code display */}
      {code && (
        <div className="border-b border-zinc-800/50">
          <div className="px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30 flex items-center gap-1.5">
            <Play className="w-3 h-3 text-muted-foreground/50" />
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
              Code
            </span>
          </div>
          <pre className="p-3 bg-zinc-950/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-all overflow-auto max-h-[200px]">
            {code}
          </pre>
        </div>
      )}

      {/* Output area */}
      <div className="flex-1 overflow-auto">
        {/* stdout/stderr */}
        {(hasOutput || isRunning) && (
          <div className="border-b border-zinc-800/30">
            <div className="px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30">
              <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Output
              </span>
            </div>
            <pre
              ref={outputRef}
              className="p-3 bg-zinc-950/40 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all max-h-[300px] overflow-auto"
            >
              {execResult?.stdout && <span className="text-zinc-300">{execResult.stdout}</span>}
              {execResult?.stderr && <span className="text-red-400">{execResult.stderr}</span>}
              {execResult?.returnValue && (
                <span className="text-emerald-400/70">
                  {"\n→ "}
                  {execResult.returnValue}
                </span>
              )}
              {isRunning && !execResult && (
                <span className="text-zinc-500 animate-pulse">
                  {language === "python" ? "Loading Python runtime..." : "Executing..."}
                </span>
              )}
              {!hasOutput && !isRunning && isCompleted && !execResult && (
                <span className="text-zinc-600">Awaiting output...</span>
              )}
            </pre>
          </div>
        )}

        {/* Generated images */}
        {hasImages && (
          <div>
            <div className="px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30 flex items-center gap-1.5">
              <Image className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Charts ({execResult.images.length})
              </span>
            </div>
            <div className="p-3 space-y-3">
              {execResult.images.map((dataUrl, i) => (
                <img
                  key={i}
                  src={dataUrl}
                  alt={`Generated chart ${i + 1}`}
                  className="rounded-lg border border-zinc-800/30 max-w-full"
                />
              ))}
            </div>
          </div>
        )}

        {/* Hidden iframe for execution */}
        {iframeSrc && !execResult && (
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            sandbox="allow-scripts allow-forms"
            onLoad={() => setIframeLoaded(true)}
            className="w-full h-0 border-0 opacity-0 pointer-events-none"
            title="Code execution sandbox"
          />
        )}
      </div>
    </div>
  );
}
