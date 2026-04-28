import { useCallback, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

const TEMPLATES: Record<string, { label: string; content: string }> = {
  basic: {
    label: "Basic skill",
    content: `---
name: my-skill
description: A short one-line description of what this skill does.
emoji: 🛠️
---

## When to use

Describe the situations where the agent should reach for this skill.

## How it works

Describe the steps, tools, or knowledge the agent should apply.

## Examples

- Example 1: …
- Example 2: …
`,
  },
  api: {
    label: "API-backed skill",
    content: `---
name: my-api-skill
description: Wraps an external API. Replace primaryEnv with your env var name.
emoji: 🌐
primaryEnv: MY_API_KEY
requires:
  env:
    - MY_API_KEY
---

## When to use

When the user asks for something this API provides.

## API reference

Explain the endpoints, parameters, and expected responses the agent
needs to know to call this API correctly.
`,
  },
  shell: {
    label: "Shell-tool skill",
    content: `---
name: my-cli-skill
description: Calls a local CLI tool. Lists required binaries.
emoji: 🐚
requires:
  bins:
    - jq
os:
  - darwin
  - linux
---

## When to use

When the task involves transforming JSON or invoking the listed tools.

## Usage notes

Document the exact commands and flags the agent should prefer.
`,
  },
};

export function SkillEditor({ onClose }: { onClose: () => void }) {
  const request = useGatewayStore((s) => s.request);
  const [templateKey, setTemplateKey] = useState<string>("basic");
  const [name, setName] = useState("");
  const [content, setContent] = useState(TEMPLATES.basic.content);
  const [target, setTarget] = useState<"managed" | "workspace">("managed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = useCallback((key: string) => {
    setTemplateKey(key);
    const tpl = TEMPLATES[key];
    if (tpl) setContent(tpl.content);
  }, []);

  const validation = useMemo(() => {
    const trimmed = content.trim();
    if (!trimmed.startsWith("---")) {
      return { ok: false, message: "SKILL.md must start with --- (YAML frontmatter)." };
    }
    const end = trimmed.indexOf("\n---", 3);
    if (end === -1) {
      return { ok: false, message: "Frontmatter is not closed (missing trailing ---)." };
    }
    const fm = trimmed.slice(3, end);
    if (!/\bname\s*:/.test(fm)) {
      return { ok: false, message: "Frontmatter must include a 'name:' field." };
    }
    if (!/\bdescription\s*:/.test(fm)) {
      return { ok: false, message: "Frontmatter must include a 'description:' field." };
    }
    return { ok: true as const, message: "" };
  }, [content]);

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request("skills.create", {
        name: trimmedName,
        content,
        target,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [content, name, onClose, request, target, validation]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-border/30 bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
          <h2 className="text-lg font-semibold text-foreground">Create skill</h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Skill name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                disabled={busy}
                className={cn(
                  "w-full h-8 px-3 text-sm rounded-md border bg-transparent text-foreground",
                  "border-border/30 focus:border-purple-500 focus:outline-none",
                )}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Save to</span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value as "managed" | "workspace")}
                disabled={busy}
                className={cn(
                  "w-full h-8 px-2 text-sm rounded-md border bg-transparent text-foreground",
                  "border-border/30 focus:border-purple-500 focus:outline-none",
                )}
              >
                <option value="managed">Managed (~/.bitterbot/skills)</option>
                <option value="workspace">Workspace (current agent)</option>
              </select>
            </label>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Template</span>
              <div className="flex gap-1">
                {Object.entries(TEMPLATES).map(([key, tpl]) => (
                  <button
                    key={key}
                    onClick={() => applyTemplate(key)}
                    disabled={busy}
                    className={cn(
                      "px-2 py-0.5 text-[11px] rounded border transition-colors",
                      key === templateKey
                        ? "bg-purple-500/15 border-purple-500/30 text-foreground"
                        : "border-border/30 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <label className="space-y-1 block">
            <span className="text-xs text-muted-foreground">SKILL.md content</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={busy}
              spellCheck={false}
              rows={20}
              className={cn(
                "w-full px-3 py-2 text-xs font-mono rounded-md border bg-transparent text-foreground resize-none",
                "border-border/30 focus:border-purple-500 focus:outline-none",
              )}
            />
          </label>
          {!validation.ok && <div className="text-xs text-amber-300">{validation.message}</div>}
          {error && <div className="text-xs text-red-300">{error}</div>}
          <p className="text-[11px] text-muted-foreground">
            Skills you create stay disabled until you toggle them on. The agent will automatically
            see new skills on its next turn.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/20">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md border border-border/30 text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !validation.ok || !name.trim()}
            className={cn(
              "px-3 py-1.5 text-xs rounded-md border transition-colors",
              "bg-purple-500/15 text-purple-200 border-purple-500/30 hover:bg-purple-500/25",
              (busy || !validation.ok || !name.trim()) && "opacity-50 cursor-not-allowed",
            )}
          >
            {busy ? "Saving…" : "Save skill"}
          </button>
        </div>
      </div>
    </div>
  );
}
