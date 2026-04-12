import {
  FolderOpen,
  FolderClosed,
  FileCode,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Copy,
  Pencil,
  Eye,
} from "lucide-react";
import { useEffect, useCallback, useState, useMemo } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useWorkspaceStore, type FileTreeNode } from "../../stores/workspace-store";
import { ContentSearchPanel } from "./ContentSearchPanel";
import { FileBreadcrumb } from "./FileBreadcrumb";
import { FileEditor } from "./FileEditor";
import { FileTabBar } from "./FileTabBar";
import { QuickOpenDialog } from "./QuickOpenDialog";
import { SyntaxViewer } from "./SyntaxViewer";
import { TreeFilterInput } from "./TreeFilterInput";
import { getFileIcon, formatSize, filterTree } from "./workspace-utils";

/** Single tree node row */
function TreeNode({
  node,
  depth,
  expanded,
  activeFilePath,
  onToggleDir,
  onOpenFile,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  activeFilePath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDir = node.type === "directory";
  const isExpanded = expanded.has(node.path);
  const isActive = !isDir && node.path === activeFilePath;

  const FileIcon = isDir ? (isExpanded ? FolderOpen : FolderClosed) : getFileIcon(node.name);
  const Chevron = isDir ? (isExpanded ? ChevronDown : ChevronRight) : null;

  return (
    <>
      <button
        onClick={() => (isDir ? onToggleDir(node.path) : onOpenFile(node.path))}
        className={cn(
          "w-full flex items-center gap-1 py-[3px] px-2 text-left text-[12px] font-mono",
          "hover:bg-[rgba(139,92,246,0.06)] transition-colors",
          isActive && "bg-[rgba(139,92,246,0.12)] text-purple-300",
          !isActive && "text-zinc-400",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {Chevron && <Chevron className="w-3 h-3 flex-shrink-0 text-zinc-500" />}
        {!Chevron && <span className="w-3 flex-shrink-0" />}
        <FileIcon
          className={cn(
            "w-3.5 h-3.5 flex-shrink-0",
            isDir ? "text-amber-400/70" : "text-blue-400/60",
          )}
        />
        <span className="truncate">{node.name}</span>
        {!isDir && node.size !== undefined && (
          <span className="ml-auto text-[10px] text-zinc-600 flex-shrink-0">
            {formatSize(node.size)}
          </span>
        )}
      </button>
      {isDir &&
        isExpanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            activeFilePath={activeFilePath}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  );
}

/** File content area with SyntaxViewer or FileEditor */
function FileContent() {
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
  const fileLoading = useWorkspaceStore((s) => s.fileLoading);
  const fileError = useWorkspaceStore((s) => s.fileError);
  const setEditing = useWorkspaceStore((s) => s.setEditing);
  const updateEditContent = useWorkspaceStore((s) => s.updateEditContent);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);
  const setHighlightedHtml = useWorkspaceStore((s) => s.setHighlightedHtml);

  const tab = activeTabPath ? openTabs.get(activeTabPath) : undefined;

  if (fileLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-zinc-500 animate-pulse">Loading file...</div>
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-red-400">{fileError}</div>
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2 text-zinc-500">
          <FileCode className="w-10 h-10 mx-auto opacity-30" />
          <p className="text-sm">Select a file to view</p>
          <p className="text-xs text-zinc-600">
            Click any file in the tree or press Ctrl+P to quick open
          </p>
        </div>
      </div>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(tab.content).catch(() => {});
  };

  const handleToggleEdit = () => {
    setEditing(tab.path, !tab.editing);
  };

  const handleSave = () => {
    saveActiveFile();
  };

  const handleHighlighted = useCallback(
    (html: string) => {
      setHighlightedHtml(tab.path, html);
    },
    [tab.path, setHighlightedHtml],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* File header bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/50 bg-zinc-900/40">
        <span className="text-[10px] text-zinc-500 flex-shrink-0 font-mono">{tab.language}</span>
        <span className="text-[10px] text-zinc-600 flex-shrink-0">{formatSize(tab.size)}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleToggleEdit}
            className={cn(
              "w-6 h-6 flex items-center justify-center rounded transition-colors",
              tab.editing
                ? "bg-purple-500/20 text-purple-300"
                : "hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300",
            )}
            title={tab.editing ? "View mode" : "Edit mode"}
          >
            {tab.editing ? <Eye className="w-3 h-3" /> : <Pencil className="w-3 h-3" />}
          </button>
          <button
            onClick={handleCopy}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Copy content"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Viewer or Editor */}
      {tab.editing ? (
        <FileEditor
          content={tab.editContent}
          lineCount={tab.content.split("\n").length}
          onContentChange={(val) => updateEditContent(tab.path, val)}
          onSave={handleSave}
          onExit={() => setEditing(tab.path, false)}
        />
      ) : (
        <SyntaxViewer
          code={tab.content}
          language={tab.language}
          cachedHtml={tab.highlightedHtml}
          onHighlighted={handleHighlighted}
        />
      )}
    </div>
  );
}

export function WorkspaceView() {
  const status = useGatewayStore((s) => s.status);
  const tree = useWorkspaceStore((s) => s.tree);
  const root = useWorkspaceStore((s) => s.root);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const tabOrder = useWorkspaceStore((s) => s.tabOrder);
  const treeFilter = useWorkspaceStore((s) => s.treeFilter);
  const treeLoading = useWorkspaceStore((s) => s.treeLoading);
  const treeError = useWorkspaceStore((s) => s.treeError);
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const expandDir = useWorkspaceStore((s) => s.expandDir);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const setEditing = useWorkspaceStore((s) => s.setEditing);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);
  const setTreeFilter = useWorkspaceStore((s) => s.setTreeFilter);

  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const isConnected = status === "connected";

  // Filtered tree
  const filteredTree = useMemo(() => filterTree(tree, treeFilter), [tree, treeFilter]);

  // Load tree on mount / when connected
  useEffect(() => {
    if (isConnected && tree.length === 0 && !treeLoading) {
      loadTree();
    }
  }, [isConnected, tree.length, treeLoading, loadTree]);

  // Subscribe to workspace file change events for auto-refresh
  useEffect(() => {
    const { subscribe } = useGatewayStore.getState();
    const unsub = subscribe((evt) => {
      if (evt.event === "workspace.fileChanged") {
        loadTree();
      }
    });
    return unsub;
  }, [loadTree]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+P → Quick Open
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setQuickOpenOpen(true);
        return;
      }
      // Ctrl+Shift+F → Toggle content search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setShowSearch((v) => !v);
        return;
      }
      // Ctrl+S → Save active file
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveActiveFile();
        return;
      }
      // Ctrl+W → Close active tab
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        if (activeTabPath) closeTab(activeTabPath);
        return;
      }
      // Ctrl+E → Toggle edit mode
      if ((e.ctrlKey || e.metaKey) && e.key === "e") {
        e.preventDefault();
        if (activeTabPath) {
          const tab = openTabs.get(activeTabPath);
          if (tab) setEditing(activeTabPath, !tab.editing);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabPath, openTabs, closeTab, setEditing, saveActiveFile]);

  const handleRefresh = useCallback(() => {
    loadTree();
  }, [loadTree]);

  const handleBreadcrumbNavigate = useCallback(
    (dirPath: string) => {
      expandDir(dirPath);
    },
    [expandDir],
  );

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-500">Connecting to gateway...</p>
      </div>
    );
  }

  const activeTab = activeTabPath ? openTabs.get(activeTabPath) : undefined;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border/30">
        <FolderOpen className="w-4 h-4 text-purple-400" />
        <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
        {root && (
          <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[400px]">{root}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleRefresh}
            disabled={treeLoading}
            className={cn(
              "w-7 h-7 flex items-center justify-center rounded-md transition-colors text-muted-foreground",
              treeLoading
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-accent hover:text-foreground",
            )}
            title="Refresh file tree"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", treeLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Main content: tree + viewer */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left pane: file tree or search */}
        <div className="w-[260px] flex-shrink-0 border-r border-zinc-800/40 flex flex-col bg-zinc-900/20">
          {showSearch ? (
            <ContentSearchPanel onClose={() => setShowSearch(false)} />
          ) : (
            <>
              <TreeFilterInput value={treeFilter} onChange={setTreeFilter} />
              <div className="flex-1 overflow-y-auto scrollbar-none">
                {treeLoading && tree.length === 0 ? (
                  <div className="p-4 text-xs text-zinc-500 animate-pulse">
                    Loading workspace...
                  </div>
                ) : treeError ? (
                  <div className="p-4 text-xs text-red-400">{treeError}</div>
                ) : filteredTree.length === 0 ? (
                  <div className="p-4 text-xs text-zinc-600">
                    {treeFilter ? "No matching files" : "Workspace is empty"}
                  </div>
                ) : (
                  <div className="py-1">
                    {filteredTree.map((node) => (
                      <TreeNode
                        key={node.path}
                        node={node}
                        depth={0}
                        expanded={expanded}
                        activeFilePath={activeTabPath}
                        onToggleDir={toggleDir}
                        onOpenFile={openFile}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right pane: tabs + breadcrumb + viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          <FileTabBar
            tabs={openTabs}
            tabOrder={tabOrder}
            activeTabPath={activeTabPath}
            onActivate={activateTab}
            onClose={closeTab}
          />
          {activeTab && activeTabPath && (
            <FileBreadcrumb filePath={activeTabPath} onNavigateDir={handleBreadcrumbNavigate} />
          )}
          <FileContent />
        </div>
      </div>

      {/* Quick Open overlay */}
      <QuickOpenDialog open={quickOpenOpen} onOpenChange={setQuickOpenOpen} />
    </div>
  );
}
