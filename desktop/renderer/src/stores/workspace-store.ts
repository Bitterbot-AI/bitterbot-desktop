import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export type FileTreeNode = {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "directory";
  size?: number;
  children?: FileTreeNode[];
};

export type TabEntry = {
  path: string;
  content: string;
  editContent: string;
  size: number;
  modifiedAt: number;
  language: string;
  highlightedHtml: string | null;
  editing: boolean;
  dirty: boolean;
};

export type SearchResult = {
  path: string;
  line: number;
  column: number;
  content: string;
};

interface WorkspaceState {
  /** Workspace root path on disk */
  root: string | null;
  /** Recursive file tree */
  tree: FileTreeNode[];
  /** Set of expanded directory paths */
  expanded: Set<string>;

  /** Open tabs keyed by path */
  openTabs: Map<string, TabEntry>;
  /** Ordered tab paths */
  tabOrder: string[];
  /** Currently active tab path */
  activeTabPath: string | null;

  /** Tree filter string */
  treeFilter: string;

  /** Content search results */
  searchResults: SearchResult[];
  searchLoading: boolean;

  /** Loading states */
  treeLoading: boolean;
  fileLoading: boolean;
  /** Error messages */
  treeError: string | null;
  fileError: string | null;

  /** Load the full file tree from gateway */
  loadTree: (agentId?: string) => Promise<void>;
  /** Toggle a directory open/closed */
  toggleDir: (dirPath: string) => void;
  /** Expand a directory */
  expandDir: (dirPath: string) => void;
  /** Open a file - adds to tabs if not present, sets active */
  openFile: (filePath: string, agentId?: string) => Promise<void>;
  /** Save file content */
  saveFile: (filePath: string, content: string, agentId?: string) => Promise<void>;

  /** Activate an existing tab */
  activateTab: (path: string) => void;
  /** Close a tab, activate adjacent */
  closeTab: (path: string) => void;
  /** Close all tabs except the given one */
  closeOtherTabs: (path: string) => void;
  /** Toggle edit mode for a tab */
  setEditing: (path: string, editing: boolean) => void;
  /** Update the edit content (marks dirty) */
  updateEditContent: (path: string, content: string) => void;
  /** Save active file - writes editContent via RPC, clears dirty */
  saveActiveFile: (agentId?: string) => Promise<void>;
  /** Set cached highlighted HTML for a tab */
  setHighlightedHtml: (path: string, html: string) => void;

  /** Set tree filter string */
  setTreeFilter: (filter: string) => void;
  /** Search file contents via backend RPC */
  searchContent: (
    query: string,
    opts?: { regex?: boolean; caseSensitive?: boolean },
    agentId?: string,
  ) => Promise<void>;
  /** Clear search results */
  clearSearch: () => void;

  /** Clear all state */
  reset: () => void;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    xml: "xml",
    svg: "svg",
    txt: "plaintext",
  };
  return map[ext] ?? "plaintext";
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  tree: [],
  expanded: new Set<string>(),

  openTabs: new Map<string, TabEntry>(),
  tabOrder: [],
  activeTabPath: null,

  treeFilter: "",
  searchResults: [],
  searchLoading: false,

  treeLoading: false,
  fileLoading: false,
  treeError: null,
  fileError: null,

  loadTree: async (agentId?: string) => {
    set({ treeLoading: true, treeError: null });
    try {
      const { request } = useGatewayStore.getState();
      const res = await request<{ root: string; tree: FileTreeNode[] }>(
        "workspace.tree",
        agentId ? { agentId } : {},
      );
      set({ root: res.root, tree: res.tree, treeLoading: false });
    } catch (err) {
      set({ treeError: String(err), treeLoading: false });
    }
  },

  toggleDir: (dirPath: string) => {
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return { expanded: next };
    });
  },

  expandDir: (dirPath: string) => {
    set((s) => {
      if (s.expanded.has(dirPath)) return s;
      const next = new Set(s.expanded);
      next.add(dirPath);
      return { expanded: next };
    });
  },

  openFile: async (filePath: string, agentId?: string) => {
    const state = get();
    // If already open, just activate
    if (state.openTabs.has(filePath)) {
      set({ activeTabPath: filePath });
      return;
    }

    set({ fileLoading: true, fileError: null });
    try {
      const { request } = useGatewayStore.getState();
      const res = await request<{
        path: string;
        content: string;
        size: number;
        modifiedAt: number;
      }>("workspace.read", {
        path: filePath,
        ...(agentId ? { agentId } : {}),
      });

      // Auto-expand parent directories
      const parts = filePath.split("/");
      const expanded = new Set(get().expanded);
      for (let i = 1; i < parts.length; i++) {
        expanded.add(parts.slice(0, i).join("/"));
      }

      const language = detectLanguage(res.path);
      const tab: TabEntry = {
        path: res.path,
        content: res.content,
        editContent: res.content,
        size: res.size,
        modifiedAt: res.modifiedAt,
        language,
        highlightedHtml: null,
        editing: false,
        dirty: false,
      };

      const newTabs = new Map(get().openTabs);
      newTabs.set(filePath, tab);
      const newOrder = [...get().tabOrder, filePath];

      set({
        openTabs: newTabs,
        tabOrder: newOrder,
        activeTabPath: filePath,
        expanded,
        fileLoading: false,
      });
    } catch (err) {
      set({ fileError: String(err), fileLoading: false });
    }
  },

  saveFile: async (filePath: string, content: string, agentId?: string) => {
    try {
      const { request } = useGatewayStore.getState();
      await request("workspace.write", {
        path: filePath,
        content,
        ...(agentId ? { agentId } : {}),
      });
      // Update tab state
      const tabs = new Map(get().openTabs);
      const tab = tabs.get(filePath);
      if (tab) {
        tabs.set(filePath, {
          ...tab,
          content,
          editContent: content,
          size: content.length,
          modifiedAt: Date.now(),
          dirty: false,
          editing: false,
          highlightedHtml: null, // invalidate cache
        });
        set({ openTabs: tabs });
      }
    } catch (err) {
      set({ fileError: String(err) });
    }
  },

  activateTab: (path: string) => {
    if (get().openTabs.has(path)) {
      set({ activeTabPath: path });
    }
  },

  closeTab: (path: string) => {
    const { openTabs, tabOrder, activeTabPath } = get();
    const newTabs = new Map(openTabs);
    newTabs.delete(path);
    const newOrder = tabOrder.filter((p) => p !== path);

    let newActive = activeTabPath;
    if (activeTabPath === path) {
      // Activate adjacent tab
      const oldIdx = tabOrder.indexOf(path);
      if (newOrder.length === 0) {
        newActive = null;
      } else if (oldIdx >= newOrder.length) {
        newActive = newOrder[newOrder.length - 1];
      } else {
        newActive = newOrder[oldIdx];
      }
    }

    set({
      openTabs: newTabs,
      tabOrder: newOrder,
      activeTabPath: newActive,
      fileError: null,
    });
  },

  closeOtherTabs: (path: string) => {
    const { openTabs } = get();
    const tab = openTabs.get(path);
    if (!tab) return;
    const newTabs = new Map<string, TabEntry>();
    newTabs.set(path, tab);
    set({
      openTabs: newTabs,
      tabOrder: [path],
      activeTabPath: path,
    });
  },

  setEditing: (path: string, editing: boolean) => {
    const tabs = new Map(get().openTabs);
    const tab = tabs.get(path);
    if (!tab) return;
    tabs.set(path, {
      ...tab,
      editing,
      // When entering edit mode, sync editContent with current content
      editContent: editing ? tab.editContent : tab.editContent,
    });
    set({ openTabs: tabs });
  },

  updateEditContent: (path: string, content: string) => {
    const tabs = new Map(get().openTabs);
    const tab = tabs.get(path);
    if (!tab) return;
    tabs.set(path, {
      ...tab,
      editContent: content,
      dirty: content !== tab.content,
    });
    set({ openTabs: tabs });
  },

  saveActiveFile: async (agentId?: string) => {
    const { activeTabPath, openTabs } = get();
    if (!activeTabPath) return;
    const tab = openTabs.get(activeTabPath);
    if (!tab || !tab.dirty) return;
    await get().saveFile(activeTabPath, tab.editContent, agentId);
  },

  setHighlightedHtml: (path: string, html: string) => {
    const tabs = new Map(get().openTabs);
    const tab = tabs.get(path);
    if (!tab) return;
    tabs.set(path, { ...tab, highlightedHtml: html });
    set({ openTabs: tabs });
  },

  setTreeFilter: (filter: string) => {
    set({ treeFilter: filter });
  },

  searchContent: async (
    query: string,
    opts?: { regex?: boolean; caseSensitive?: boolean },
    agentId?: string,
  ) => {
    if (!query.trim()) {
      set({ searchResults: [], searchLoading: false });
      return;
    }
    set({ searchLoading: true });
    try {
      const { request } = useGatewayStore.getState();
      const res = await request<{ results: SearchResult[] }>("workspace.search", {
        query,
        regex: opts?.regex ?? false,
        caseSensitive: opts?.caseSensitive ?? false,
        ...(agentId ? { agentId } : {}),
      });
      set({ searchResults: res.results, searchLoading: false });
    } catch (err) {
      set({ searchResults: [], searchLoading: false });
    }
  },

  clearSearch: () => {
    set({ searchResults: [], searchLoading: false });
  },

  reset: () =>
    set({
      root: null,
      tree: [],
      expanded: new Set(),
      openTabs: new Map(),
      tabOrder: [],
      activeTabPath: null,
      treeFilter: "",
      searchResults: [],
      searchLoading: false,
      treeLoading: false,
      fileLoading: false,
      treeError: null,
      fileError: null,
    }),
}));
