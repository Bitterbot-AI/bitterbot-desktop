import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { ensureDir } from "../../utils.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

export type ArtifactType = "react" | "html" | "svg" | "mermaid" | "javascript";

const ARTIFACT_TYPES = ["react", "html", "svg", "mermaid", "javascript"] as const;

const ArtifactToolSchema = Type.Object({
  type: stringEnum(ARTIFACT_TYPES),
  title: Type.String(),
  content: Type.String(),
  identifier: Type.String(),
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapReactArtifact(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js" crossorigin><\/script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js" crossorigin><\/script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"><\/script>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/recharts@2/umd/Recharts.min.js" crossorigin><\/script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lucide-static@latest/font/lucide.min.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; width: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fafafa; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-type="module">
    ${content}
  <\/script>
  <script>
    window.onerror = function(msg, src, line, col, err) {
      try {
        window.parent.postMessage({ type: 'artifact-error', error: String(msg), line, col }, '*');
      } catch(e) {}
    };
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        try {
          window.parent.postMessage({
            type: 'artifact-resize',
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          }, '*');
        } catch(e) {}
      }
    });
    ro.observe(document.getElementById('root'));
  <\/script>
</body>
</html>`;
}

function wrapHtmlArtifact(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 16px; }
  </style>
</head>
<body>
  ${content}
  <script>
    window.onerror = function(msg, src, line, col) {
      try { window.parent.postMessage({ type: 'artifact-error', error: String(msg), line, col }, '*'); } catch(e) {}
    };
  <\/script>
</body>
</html>`;
}

function wrapSvgArtifact(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0a0a0a; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  ${content}
</body>
</html>`;
}

function wrapMermaidArtifact(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0a0a0a; color: #fafafa; }
  </style>
</head>
<body>
  <pre class="mermaid">
${escapeHtml(content)}
  </pre>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  <\/script>
</body>
</html>`;
}

function wrapJavaScriptArtifact(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: monospace; background: #0a0a0a; color: #fafafa; margin: 0; padding: 16px; }
    #output { white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div id="output"></div>
  <script>
    const _out = document.getElementById('output');
    const _origLog = console.log;
    console.log = function(...args) {
      _origLog.apply(console, args);
      _out.textContent += args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') + '\\n';
    };
    console.error = function(...args) {
      _origLog.apply(console, args);
      const span = document.createElement('span');
      span.style.color = '#ff5c5c';
      span.textContent = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') + '\\n';
      _out.appendChild(span);
    };
    window.onerror = function(msg, src, line, col) {
      try { window.parent.postMessage({ type: 'artifact-error', error: String(msg), line, col }, '*'); } catch(e) {}
    };
    try {
      ${content}
    } catch(e) {
      console.error(e);
    }
  <\/script>
</body>
</html>`;
}

function wrapArtifactContent(type: ArtifactType, title: string, content: string): string {
  switch (type) {
    case "react":
      return wrapReactArtifact(title, content);
    case "html":
      return wrapHtmlArtifact(title, content);
    case "svg":
      return wrapSvgArtifact(title, content);
    case "mermaid":
      return wrapMermaidArtifact(title, content);
    case "javascript":
      return wrapJavaScriptArtifact(title, content);
    default:
      return wrapHtmlArtifact(title, content);
  }
}

function resolveArtifactsDir(): string {
  return path.join(resolveStateDir(), "canvas", "artifacts");
}

export function createArtifactTool(): AnyAgentTool {
  return {
    label: "Artifact",
    name: "create_artifact",
    description:
      "Create an interactive artifact (React component, HTML page, SVG graphic, Mermaid diagram, or JavaScript app) that will be rendered in a sandboxed preview panel. Use this when the user asks for interactive demos, visualizations, charts, games, calculators, or any visual/interactive content.",
    parameters: ArtifactToolSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const type = readStringParam(params, "type", { required: true }) as ArtifactType;
      const title = readStringParam(params, "title", { required: true });
      const content = readStringParam(params, "content", { required: true });
      const identifier = readStringParam(params, "identifier", { required: true });

      const safeId = identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
      const artifactsDir = resolveArtifactsDir();
      await ensureDir(artifactsDir);

      const filePath = path.join(artifactsDir, `${safeId}.html`);
      const html = wrapArtifactContent(type, title, content);

      await fs.writeFile(filePath, html, "utf8");

      return jsonResult({
        ok: true,
        artifactId: safeId,
        type,
        title,
        message: `Artifact "${title}" created successfully. It is now visible in the Artifact panel.`,
      });
    },
  };
}
