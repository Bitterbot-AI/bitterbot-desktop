import { useEffect, useState, useMemo, useCallback } from "react";
import { useWorkspaceStore, type FileTreeNode } from "../../stores/workspace-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { cn } from "../../lib/utils";
import {
  FolderOpen,
  FolderClosed,
  FileCode,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Copy,
  Pencil,
  Eye,
} from "lucide-react";
import { getFileIcon, formatSize, filterTree } from "./workspace-utils";
import { SyntaxViewer } from "./SyntaxViewer";
import { FileEditor } from "./FileEditor";
import { FileTabBar } from "./FileTabBar";
import { TreeFilterInput } from "./TreeFilterInput";

function MiniTreeNode({
  node,
  depth,
  expanded,
  activeFilePath,
  onToggle,
  onOpen,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  activeFilePath: string | null;
  onToggle: (p: string) => void;
  onOpen: (p: string) => void;
}) {
  const isDir = node.type === "directory";
  const isExpanded = expanded.has(node.path);
  const isActive = !isDir && node.path === activeFilePath;
  const NodeIcon = isDir ? (isExpanded ? FolderOpen : FolderClosed) : getFileIcon(node.name);

  return (
    <>
      <button
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path))}
        className={cn(
          "w-full flex items-center gap-1 py-[2px] px-1 text-left text-[11px] font-mono",
          "hover:bg-[rgba(139,92,246,0.06)] transition-colors",
          isActive && "bg-[rgba(139,92,246,0.12)] text-purple-300",
          !isActive && "text-zinc-400",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="w-2.5 h-2.5 text-zinc-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-2.5 h-2.5 text-zinc-500 flex-shrink-0" />
          )
        ) : (
          <span className="w-2.5 flex-shrink-0" />
        )}
        <NodeIcon
          className={cn(
            "w-3 h-3 flex-shrink-0",
            isDir ? "text-amber-400/70" : "text-blue-400/60",
          )}
        />
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && isExpanded && node.children?.map((child) => (
        <MiniTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          activeFilePath={activeFilePath}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/**
 * Compact workspace file panel for the right-side ToolCallPanel.
 * Shows tree + inline file viewer in a single vertical layout.
 */
export function WorkspaceFilesPanel() {
  const status = useGatewayStore((s) => s.status);
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const tabOrder = useWorkspaceStore((s) => s.tabOrder);
  const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
  const treeFilter = useWorkspaceStore((s) => s.treeFilter);
  const treeLoading = useWorkspaceStore((s) => s.treeLoading);
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const setEditing = useWorkspaceStore((s) => s.setEditing);
  const updateEditContent = useWorkspaceStore((s) => s.updateEditContent);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);
  const setHighlightedHtml = useWorkspaceStore((s) => s.setHighlightedHtml);
  const setTreeFilter = useWorkspaceStore((s) => s.setTreeFilter);

  const isConnected = status === "connected";

  const filteredTree = useMemo(
    () => filterTree(tree, treeFilter),
    [tree, treeFilter],
  );

  useEffect(() => {
    if (isConnected && tree.length === 0 && !treeLoading) {
      loadTree();
    }
  }, [isConnected, tree.length, treeLoading, loadTree]);

  // Auto-refresh on file changes
  useEffect(() => {
    const { subscribe } = useGatewayStore.getState();
    const unsub = subscribe((evt) => {
      if (evt.event === "workspace.fileChanged") {
        loadTree();
      }
    });
    return unsub;
  }, [loadTree]);

  // Keyboard shortcuts when panel focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveActiveFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "e") {
        e.preventDefault();
        if (activeTabPath) {
          const tab = openTabs.get(activeTabPath);
          if (tab) setEditing(activeTabPath, !tab.editing);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        if (activeTabPath) closeTab(activeTabPath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabPath, openTabs, closeTab, setEditing, saveActiveFile]);

  const activeTab = activeTabPath ? openTabs.get(activeTabPath) : undefined;

  const handleHighlighted = useCallback(
    (html: string) => {
      if (activeTabPath) setHighlightedHtml(activeTabPath, html);
    },
    [activeTabPath, setHighlightedHtml],
  );

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-zinc-500">Not connected</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* If tabs are open, show tab bar + viewer */}
      {tabOrder.length > 0 ? (
        <>
          <FileTabBar
            tabs={openTabs}
            tabOrder={tabOrder}
            activeTabPath={activeTabPath}
            onActivate={activateTab}
            onClose={closeTab}
            compact
          />

          {activeTab ? (
            <>
              {/* Compact file header */}
              <div className="flex-shrink-0 flex items-center gap-2 px-2 py-1 border-b border-zinc-800/40 bg-zinc-900/40">
                <span className="text-[10px] font-mono text-zinc-500 truncate flex-1">
                  {activeTab.path}
                </span>
                <button
                  onClick={() => setEditing(activeTab.path, !activeTab.editing)}
                  className={cn(
                    "w-5 h-5 flex items-center justify-center rounded transition-colors",
                    activeTab.editing
                      ? "bg-purple-500/20 text-purple-300"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                  title={activeTab.editing ? "View mode" : "Edit mode"}
                >
                  {activeTab.editing ? <Eye className="w-2.5 h-2.5" /> : <Pencil className="w-2.5 h-2.5" />}
                </button>
                <button
                  onClick={() => navigator.clipboard.writeText(activeTab.content).catch(() => {})}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-colors"
                  title="Copy"
                >
                  <Copy className="w-2.5 h-2.5" />
                </button>
              </div>

              {/* Viewer or editor */}
              {activeTab.editing ? (
                <FileEditor
                  content={activeTab.editContent}
                  lineCount={activeTab.content.split("\n").length}
                  onContentChange={(val) => updateEditContent(activeTab.path, val)}
                  onSave={() => saveActiveFile()}
                  onExit={() => setEditing(activeTab.path, false)}
                />
              ) : (
                <SyntaxViewer
                  code={activeTab.content}
                  language={activeTab.language}
                  cachedHtml={activeTab.highlightedHtml}
                  onHighlighted={handleHighlighted}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-xs text-zinc-500">Select a tab</div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Tree header */}
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800/40">
            <FolderOpen className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-xs font-medium text-zinc-300">Workspace Files</span>
            <button
              onClick={() => loadTree()}
              disabled={treeLoading}
              className="ml-auto w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Refresh"
            >
              <RefreshCw className={cn("w-3 h-3", treeLoading && "animate-spin")} />
            </button>
          </div>

          <TreeFilterInput value={treeFilter} onChange={setTreeFilter} />

          {/* File tree */}
          <div className="flex-1 overflow-y-auto scrollbar-none py-1">
            {treeLoading && tree.length === 0 ? (
              <div className="p-3 text-xs text-zinc-500 animate-pulse">Loading...</div>
            ) : filteredTree.length === 0 ? (
              <div className="p-3 text-xs text-zinc-600">
                {treeFilter ? "No matching files" : "Workspace is empty"}
              </div>
            ) : (
              filteredTree.map((node) => (
                <MiniTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  activeFilePath={activeTabPath}
                  onToggle={toggleDir}
                  onOpen={openFile}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
