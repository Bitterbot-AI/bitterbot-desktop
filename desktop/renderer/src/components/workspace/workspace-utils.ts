import {
  File,
  FileCode,
  FileText,
  FileJson,
  Image,
} from "lucide-react";
import type { FileTreeNode } from "../../stores/workspace-store";

/** Icon component for a file based on its extension */
export function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = new Set([
    "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "c", "cpp", "h",
    "cs", "php", "swift", "kt", "scala", "sh", "bash", "zsh",
  ]);
  const textExts = new Set(["md", "txt", "log", "csv", "env", "cfg", "ini", "toml", "yaml", "yml"]);
  const jsonExts = new Set(["json", "jsonl", "jsonc"]);
  const imageExts = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);

  if (codeExts.has(ext)) return FileCode;
  if (textExts.has(ext)) return FileText;
  if (jsonExts.has(ext)) return FileJson;
  if (imageExts.has(ext)) return Image;
  return File;
}

/** Human-readable language label from file name */
export function getLangLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", jsx: "JavaScript JSX",
    py: "Python", rs: "Rust", go: "Go", java: "Java", rb: "Ruby",
    css: "CSS", scss: "SCSS", html: "HTML", json: "JSON",
    yaml: "YAML", yml: "YAML", toml: "TOML", md: "Markdown",
    sh: "Shell", sql: "SQL", xml: "XML", svg: "SVG",
  };
  return map[ext] ?? ext.toUpperCase();
}

/** Format byte count to human-readable string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recursively flatten a file tree into an array of file paths */
export function flattenTree(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  function walk(items: FileTreeNode[]) {
    for (const node of items) {
      if (node.type === "file") {
        paths.push(node.path);
      } else if (node.children) {
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return paths;
}

/** Filter tree nodes to only those whose names match the filter string (case-insensitive) */
export function filterTree(nodes: FileTreeNode[], filter: string): FileTreeNode[] {
  if (!filter) return nodes;
  const lower = filter.toLowerCase();

  return nodes.reduce<FileTreeNode[]>((acc, node) => {
    if (node.type === "file") {
      if (node.name.toLowerCase().includes(lower)) {
        acc.push(node);
      }
    } else {
      // Directory: recurse into children, keep dir if any children match
      const filteredChildren = node.children ? filterTree(node.children, filter) : [];
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(lower)) {
        acc.push({ ...node, children: filteredChildren });
      }
    }
    return acc;
  }, []);
}
