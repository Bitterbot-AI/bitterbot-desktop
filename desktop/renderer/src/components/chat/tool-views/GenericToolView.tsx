import { useState, useCallback, useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { Wrench, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../../lib/utils";
import { safeJsonParse } from "./tool-view-utils";
import { SyntaxViewer } from "../../workspace/SyntaxViewer";

const VALUE_TRUNCATE_LENGTH = 200;

/**
 * Fallback tool view for any tool without a specialized renderer.
 * Shows args as a key-value table and result with JSON highlighting.
 */
export function GenericToolView({ toolCall }: ToolViewProps) {
  const output = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";
  const args = toolCall.args as Record<string, unknown> | undefined;
  const hasArgs =
    args !== undefined &&
    args !== null &&
    typeof args === "object" &&
    Object.keys(args).length > 0;

  // Check if output is JSON for highlighting
  const formattedOutput = useMemo(() => {
    if (!output) return null;
    const trimmed = output.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 50000) {
      const parsed = safeJsonParse(trimmed, null);
      if (parsed !== null) {
        return { json: JSON.stringify(parsed, null, 2), isJson: true };
      }
    }
    return { json: output, isJson: false };
  }, [output]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
        <Wrench className="w-3.5 h-3.5 text-purple-400" />
        <span className="text-xs font-medium text-zinc-300 font-mono">
          {toolCall.name}
        </span>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Arguments as key-value table */}
        {hasArgs && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
              Parameters
            </span>
            <div className="rounded-lg bg-zinc-900/40 border border-zinc-800/30 overflow-hidden">
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(args!).map(([key, value]) => (
                    <ArgRow key={key} name={key} value={value} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Output */}
        {formattedOutput ? (
          <div className="space-y-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
              Output
            </span>
            {formattedOutput.isJson ? (
              <div className="rounded-lg border border-zinc-800/30 overflow-hidden">
                <JsonOutput json={formattedOutput.json} />
              </div>
            ) : (
              <pre className="text-xs font-mono bg-zinc-900/40 rounded-lg p-2.5 overflow-x-auto border border-zinc-800/30 text-zinc-300 whitespace-pre-wrap break-words">
                {formattedOutput.json}
              </pre>
            )}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-zinc-500 py-4">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" />
            <span className="text-sm">Executing...</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Argument row with expandable long values. */
function ArgRow({ name, value }: { name: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);

  const displayValue = useMemo(() => {
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return JSON.stringify(value, null, 2);
  }, [value]);

  const isLong = displayValue.length > VALUE_TRUNCATE_LENGTH;
  const shown = !expanded && isLong ? displayValue.slice(0, VALUE_TRUNCATE_LENGTH) : displayValue;

  return (
    <tr className="border-b border-zinc-800/20 last:border-0">
      <td className="px-2.5 py-1.5 text-zinc-500 font-mono whitespace-nowrap align-top w-[120px]">
        {name}
      </td>
      <td className="px-2.5 py-1.5 text-zinc-300 font-mono break-all">
        <span className="whitespace-pre-wrap">{shown}</span>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-purple-400 hover:text-purple-300 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3 h-3" /> less
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3" /> more
              </>
            )}
          </button>
        )}
      </td>
    </tr>
  );
}

/** JSON output with syntax highlighting via SyntaxViewer. */
function JsonOutput({ json }: { json: string }) {
  const [cachedHtml, setCachedHtml] = useState<string | null>(null);
  const handleHighlighted = useCallback((html: string) => {
    setCachedHtml(html);
  }, []);

  return (
    <SyntaxViewer
      code={json}
      language="json"
      cachedHtml={cachedHtml}
      onHighlighted={handleHighlighted}
    />
  );
}
