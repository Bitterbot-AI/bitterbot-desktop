import { X } from "lucide-react";
import type { TabEntry } from "../../stores/workspace-store";
import { cn } from "../../lib/utils";
import { getFileIcon } from "./workspace-utils";

export function FileTabBar({
  tabs,
  tabOrder,
  activeTabPath,
  onActivate,
  onClose,
  compact = false,
}: {
  tabs: Map<string, TabEntry>;
  tabOrder: string[];
  activeTabPath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  compact?: boolean;
}) {
  if (tabOrder.length === 0) return null;

  return (
    <div className="flex-shrink-0 flex items-center overflow-x-auto scrollbar-none border-b border-border/40 bg-card/30">
      {tabOrder.map((path) => {
        const tab = tabs.get(path);
        if (!tab) return null;
        const isActive = path === activeTabPath;
        const fileName = path.split("/").pop() ?? path;
        const Icon = getFileIcon(fileName);

        return (
          <button
            key={path}
            onClick={() => onActivate(path)}
            onMouseDown={(e) => {
              // Middle-click to close
              if (e.button === 1) {
                e.preventDefault();
                onClose(path);
              }
            }}
            className={cn(
              "group flex items-center gap-1.5 border-r border-border/30 transition-colors",
              compact ? "px-2 py-1 text-badge" : "px-3 py-1.5 text-2xs",
              isActive
                ? "bg-muted/50 text-foreground border-b-2 border-b-purple-500"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground border-b-2 border-b-transparent",
            )}
          >
            <Icon
              className={cn("flex-shrink-0 text-info/60", compact ? "w-2.5 h-2.5" : "w-3 h-3")}
            />
            <span className="truncate max-w-[120px] font-mono">{fileName}</span>
            {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              className={cn(
                "flex-shrink-0 rounded hover:bg-muted/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center",
                compact ? "w-3.5 h-3.5" : "w-4 h-4",
              )}
            >
              <X className={compact ? "w-2 h-2" : "w-2.5 h-2.5"} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
