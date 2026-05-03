import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const DRAFT_PREFIX = "bitterbot.skill-editor.draft.";

type ValidationResult = {
  ok: boolean;
  message: string;
  warnings: string[];
  parsed: ParsedFrontmatter | null;
};

type ParsedFrontmatter = {
  name?: string;
  description?: string;
  emoji?: string;
  primaryEnv?: string;
  unknown: Record<string, string>;
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const PLACEHOLDERS = new Set([
  "a short one-line description of what this skill does.",
  "wraps an external api. replace primaryenv with your env var name.",
  "calls a local cli tool. lists required binaries.",
]);

function parseFrontmatter(content: string): {
  raw: string | null;
  parsed: ParsedFrontmatter | null;
  closeError?: string;
} {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { raw: null, parsed: null };
  }
  const closeIdx = trimmed.indexOf("\n---", 3);
  if (closeIdx === -1) {
    return {
      raw: null,
      parsed: null,
      closeError: "Frontmatter is not closed (missing trailing ---).",
    };
  }
  const raw = trimmed.slice(3, closeIdx).trim();
  const parsed: ParsedFrontmatter = { unknown: {} };
  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!key || !value) continue;
    if (key === "name") parsed.name = value;
    else if (key === "description") parsed.description = value;
    else if (key === "emoji") parsed.emoji = value;
    else if (key === "primaryEnv") parsed.primaryEnv = value;
    else parsed.unknown[key] = value;
  }
  return { raw, parsed };
}

function validate(content: string): ValidationResult {
  const fm = parseFrontmatter(content);
  if (fm.closeError) {
    return { ok: false, message: fm.closeError, warnings: [], parsed: null };
  }
  if (!fm.parsed) {
    return {
      ok: false,
      message: "SKILL.md must start with YAML frontmatter (---).",
      warnings: [],
      parsed: null,
    };
  }
  const warnings: string[] = [];
  if (!fm.parsed.name) {
    return {
      ok: false,
      message: "Frontmatter must include a 'name:' field.",
      warnings,
      parsed: fm.parsed,
    };
  }
  if (!fm.parsed.description) {
    return {
      ok: false,
      message: "Frontmatter must include a 'description:' field.",
      warnings,
      parsed: fm.parsed,
    };
  }
  if (!NAME_RE.test(fm.parsed.name)) {
    return {
      ok: false,
      message: "name must be lowercase letters, digits, and hyphens (e.g. my-skill); 2–64 chars.",
      warnings,
      parsed: fm.parsed,
    };
  }
  if (PLACEHOLDERS.has(fm.parsed.description.toLowerCase())) {
    warnings.push("description still contains template placeholder text.");
  }
  if (fm.parsed.description.length < 12) {
    warnings.push("description is very short — consider expanding for better agent matching.");
  }
  const body = content.slice(content.indexOf("\n---", 3) + 4).trim();
  if (body.length < 20) {
    warnings.push("body looks empty — agents reach for skills with concrete When/How/Examples.");
  }
  return { ok: true, message: "", warnings, parsed: fm.parsed };
}

function loadDraft(name: string): string | null {
  if (!name) return null;
  try {
    return localStorage.getItem(DRAFT_PREFIX + name);
  } catch {
    return null;
  }
}

function saveDraft(name: string, content: string): void {
  if (!name) return;
  try {
    localStorage.setItem(DRAFT_PREFIX + name, content);
  } catch {
    // storage may be unavailable (incognito etc.) — non-fatal
  }
}

function clearDraft(name: string): void {
  if (!name) return;
  try {
    localStorage.removeItem(DRAFT_PREFIX + name);
  } catch {
    // non-fatal
  }
}

type ValidateDiagnostic = {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
};

type ValidateResponse = {
  ok: boolean;
  injectionScan?: { severity: string; flags?: string[]; reason?: string };
  diagnostics: ValidateDiagnostic[];
};

type PublishResponse = {
  ok: boolean;
  contentHash?: string;
  deliveredTo?: number;
  error?: string;
};

type UploadResponse = {
  ok: boolean;
  slug?: string;
  upstreamUrl?: string;
  error?: string;
};

export function SkillEditor({ onClose }: { onClose: () => void }) {
  const request = useGatewayStore((s) => s.request);
  const [templateKey, setTemplateKey] = useState<string>("basic");
  const [name, setName] = useState("");
  const [content, setContent] = useState(TEMPLATES.basic!.content);
  const [target, setTarget] = useState<"managed" | "workspace">("managed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saved" | "restored">("idle");
  const draftRestoredRef = useRef(false);
  const [validateBusy, setValidateBusy] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResponse | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMessage, setPublishMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // When the user types a name, look for an existing draft.
  useEffect(() => {
    if (!name || draftRestoredRef.current) return;
    const existing = loadDraft(name);
    if (existing) {
      setContent(existing);
      setDraftStatus("restored");
      draftRestoredRef.current = true;
    }
  }, [name]);

  // Persist edits to localStorage (debounced via setTimeout).
  useEffect(() => {
    if (!name) return;
    const handle = setTimeout(() => {
      saveDraft(name, content);
      setDraftStatus("saved");
    }, 400);
    return () => clearTimeout(handle);
  }, [content, name]);

  const applyTemplate = useCallback((key: string) => {
    setTemplateKey(key);
    const tpl = TEMPLATES[key];
    if (tpl) {
      setContent(tpl.content);
      draftRestoredRef.current = false;
      setDraftStatus("idle");
    }
  }, []);

  const validation = useMemo<ValidationResult>(() => validate(content), [content]);

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    monaco.editor.defineTheme("bitterbot-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0c0c0e",
      },
    });
    monaco.editor.setTheme("bitterbot-dark");
    editor.updateOptions({
      fontSize: 12,
      lineNumbers: "on",
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      renderLineHighlight: "none",
    });
  }, []);

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
      clearDraft(trimmedName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [content, name, onClose, request, target, validation]);

  const runValidate = useCallback(async () => {
    setValidateBusy(true);
    setValidateResult(null);
    try {
      const res = (await request("skills.validate", { content })) as ValidateResponse;
      setValidateResult(res);
    } catch (err) {
      setValidateResult({
        ok: false,
        diagnostics: [
          {
            severity: "error",
            code: "validator-unavailable",
            message: err instanceof Error ? err.message : "Validator unavailable",
          },
        ],
      });
    } finally {
      setValidateBusy(false);
    }
  }, [content, request]);

  const publish = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setPublishMessage({ kind: "err", text: "Name is required to publish." });
      return;
    }
    setPublishBusy(true);
    setPublishMessage(null);
    try {
      const res = (await request("skills.publish", {
        name: trimmedName,
        content,
      })) as PublishResponse;
      if (res?.ok) {
        const hashSnippet = res.contentHash ? ` (hash ${res.contentHash.slice(0, 12)}…)` : "";
        const peers = typeof res.deliveredTo === "number" ? ` to ${res.deliveredTo} peers` : "";
        setPublishMessage({
          kind: "ok",
          text: `Published${peers}${hashSnippet}.`,
        });
      } else {
        setPublishMessage({ kind: "err", text: res?.error ?? "Publish failed." });
      }
    } catch (err) {
      setPublishMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "Publish failed",
      });
    } finally {
      setPublishBusy(false);
    }
  }, [content, name, request]);

  const upload = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setUploadMessage({ kind: "err", text: "Name is required to upload." });
      return;
    }
    setUploadBusy(true);
    setUploadMessage(null);
    try {
      const res = (await request("skills.uploadAgentskills", {
        name: trimmedName,
        content,
      })) as UploadResponse;
      if (res?.ok) {
        const where = res.upstreamUrl ?? (res.slug ? `slug ${res.slug}` : "registry");
        setUploadMessage({ kind: "ok", text: `Uploaded → ${where}` });
      } else {
        setUploadMessage({ kind: "err", text: res?.error ?? "Upload failed." });
      }
    } catch (err) {
      setUploadMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setUploadBusy(false);
    }
  }, [content, name, request]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-xl border border-border/30 bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
          <h2 className="text-lg font-semibold text-foreground">Create skill</h2>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {name && draftStatus === "restored" && (
              <span className="text-amber-300">Draft restored</span>
            )}
            {name && draftStatus === "saved" && <span>Draft saved</span>}
            <button
              onClick={onClose}
              disabled={busy}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
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
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">SKILL.md content</span>
            <div
              className={cn(
                "rounded-md border bg-[#0c0c0e] overflow-hidden",
                "border-border/30 focus-within:border-purple-500",
              )}
              style={{ height: "min(58vh, 480px)" }}
            >
              <Editor
                language="markdown"
                value={content}
                onChange={(v) => setContent(v ?? "")}
                onMount={onEditorMount}
                loading={<div className="p-4 text-xs text-muted-foreground">Loading editor…</div>}
                options={{ readOnly: busy }}
              />
            </div>
          </div>
          {!validation.ok && <div className="text-xs text-amber-300">{validation.message}</div>}
          {validation.ok && validation.warnings.length > 0 && (
            <ul className="text-[11px] text-amber-300/80 list-disc list-inside space-y-0.5">
              {validation.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => void runValidate()}
              disabled={busy || validateBusy}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md border transition-colors",
                "bg-card/50 text-muted-foreground border-border/30 hover:text-foreground",
                (busy || validateBusy) && "opacity-50 cursor-not-allowed",
              )}
              title="Run frontmatter + injection-scanner + OS/bin checks"
            >
              {validateBusy ? "Validating…" : "Validate"}
            </button>
            <button
              onClick={() => void publish()}
              disabled={busy || publishBusy || !validation.ok || !name.trim()}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md border transition-colors",
                "bg-card/50 text-muted-foreground border-border/30 hover:text-foreground",
                (busy || publishBusy || !validation.ok || !name.trim()) &&
                  "opacity-50 cursor-not-allowed",
              )}
              title="Sign and broadcast over P2P (requires p2p.enabled)"
            >
              {publishBusy ? "Publishing…" : "Publish to P2P"}
            </button>
            <button
              onClick={() => void upload()}
              disabled={busy || uploadBusy || !validation.ok || !name.trim()}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md border transition-colors",
                "bg-card/50 text-muted-foreground border-border/30 hover:text-foreground",
                (busy || uploadBusy || !validation.ok || !name.trim()) &&
                  "opacity-50 cursor-not-allowed",
              )}
              title="POST to agentskills.io (requires skills.agentskills.enabled + apiKey)"
            >
              {uploadBusy ? "Uploading…" : "Upload to agentskills.io"}
            </button>
          </div>

          {validateResult && (
            <div className="space-y-1 rounded-md border border-border/20 bg-card/40 p-2">
              <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                <span>
                  Validator:{" "}
                  <span className={validateResult.ok ? "text-green-300" : "text-red-300"}>
                    {validateResult.ok ? "passed" : "failed"}
                  </span>
                  {validateResult.injectionScan && (
                    <>
                      {" · injection scan: "}
                      <span
                        className={
                          validateResult.injectionScan.severity === "ok"
                            ? "text-green-300"
                            : validateResult.injectionScan.severity === "low"
                              ? "text-yellow-300"
                              : validateResult.injectionScan.severity === "medium"
                                ? "text-amber-300"
                                : "text-red-300"
                        }
                      >
                        {validateResult.injectionScan.severity}
                      </span>
                    </>
                  )}
                </span>
                <button
                  onClick={() => setValidateResult(null)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  dismiss
                </button>
              </div>
              {validateResult.diagnostics.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">No diagnostics.</div>
              ) : (
                <ul className="text-[11px] space-y-0.5">
                  {validateResult.diagnostics.map((d, i) => (
                    <li
                      key={i}
                      className={cn(
                        d.severity === "error"
                          ? "text-red-300"
                          : d.severity === "warn"
                            ? "text-amber-300"
                            : "text-muted-foreground",
                      )}
                    >
                      <span className="font-mono mr-1.5">[{d.severity}]</span>
                      <span className="font-mono mr-1.5 opacity-70">{d.code}</span>
                      {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {publishMessage && (
            <div
              className={cn(
                "text-[11px]",
                publishMessage.kind === "ok" ? "text-green-300" : "text-red-300",
              )}
            >
              Publish: {publishMessage.text}
            </div>
          )}
          {uploadMessage && (
            <div
              className={cn(
                "text-[11px]",
                uploadMessage.kind === "ok" ? "text-green-300" : "text-red-300",
              )}
            >
              Upload: {uploadMessage.text}
            </div>
          )}

          {error && <div className="text-xs text-red-300">{error}</div>}
          <p className="text-[11px] text-muted-foreground">
            Skills you create stay disabled until you toggle them on. Drafts are auto-saved per name
            to localStorage; saving the skill clears the draft.
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
