import { useCallback, useEffect, useRef, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfigStore, type ConfigSnapshot } from "../../stores/config-store";
import { cn } from "../../lib/utils";

function ConfigFormView({
  snapshot,
  onSave,
  saving,
}: {
  snapshot: ConfigSnapshot;
  onSave: (raw: string, baseHash: string) => void;
  saving: boolean;
}) {
  const config = snapshot.config ?? {};
  const sections = Object.keys(config);

  return (
    <div className="space-y-4">
      {sections.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground text-center">
          Empty configuration
        </div>
      ) : (
        sections.map((section) => {
          const value = config[section];
          const isObject =
            typeof value === "object" && value !== null && !Array.isArray(value);
          return (
            <div
              key={section}
              className="rounded-lg border border-border/10 bg-muted/20 overflow-hidden"
            >
              <div className="px-3 py-2 bg-muted/30 border-b border-border/10">
                <span className="text-xs font-semibold text-foreground">
                  {section}
                </span>
              </div>
              <div className="p-3">
                {isObject ? (
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(value as Record<string, unknown>).map(
                      ([key, val]) => (
                        <div key={key} className="text-xs">
                          <span className="text-muted-foreground">{key}: </span>
                          <span className="text-foreground font-mono">
                            {typeof val === "string" && val.startsWith("***")
                              ? "••••••"
                              : typeof val === "object"
                                ? JSON.stringify(val).slice(0, 80)
                                : String(val)}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-foreground font-mono">
                    {typeof value === "string" && value.startsWith("***")
                      ? "••••••"
                      : JSON.stringify(value)}
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function ConfigRawView({
  draft,
  onDraftChange,
  onSave,
  onRevert,
  saving,
  baseHash,
}: {
  draft: string;
  onDraftChange: (draft: string) => void;
  onSave: (raw: string, baseHash: string) => void;
  onRevert: () => void;
  saving: boolean;
  baseHash: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(draft, baseHash)}
          disabled={saving}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg font-medium",
            "bg-purple-500 text-white hover:bg-purple-600",
            "disabled:opacity-50 transition-colors",
          )}
        >
          {saving ? "Saving…" : "Save & Apply"}
        </button>
        <button
          onClick={onRevert}
          className="px-3 py-1.5 text-xs rounded-lg bg-muted/30 text-muted-foreground hover:bg-muted/50 border border-border/20"
        >
          Revert
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        className={cn(
          "w-full min-h-[400px] p-4 text-xs font-mono rounded-xl border",
          "bg-black/20 text-foreground/90",
          "border-border/20 focus:border-purple-500/50 focus:outline-none",
          "resize-y",
        )}
        spellCheck={false}
      />
    </div>
  );
}

export function ConfigView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const snapshot = useConfigStore((s) => s.snapshot);
  const rawMode = useConfigStore((s) => s.rawMode);
  const rawDraft = useConfigStore((s) => s.rawDraft);
  const loading = useConfigStore((s) => s.loading);
  const saving = useConfigStore((s) => s.saving);
  const error = useConfigStore((s) => s.error);
  const setSnapshot = useConfigStore((s) => s.setSnapshot);
  const setRawMode = useConfigStore((s) => s.setRawMode);
  const setRawDraft = useConfigStore((s) => s.setRawDraft);
  const setLoading = useConfigStore((s) => s.setLoading);
  const setSaving = useConfigStore((s) => s.setSaving);
  const setError = useConfigStore((s) => s.setError);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("config.get", {})) as ConfigSnapshot;
      setSnapshot(res);
      if (res.raw) setRawDraft(res.raw);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setSnapshot, setRawDraft, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = useCallback(
    async (raw: string, baseHash: string) => {
      setSaving(true);
      try {
        const res = (await request("config.apply", {
          raw,
          baseHash,
        })) as { ok?: boolean };
        if (res?.ok) {
          refresh();
        }
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [request, setSaving, setError, refresh],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Config</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {snapshot?.path ?? "Gateway configuration"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-border/20">
            <button
              onClick={() => setRawMode(false)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                !rawMode
                  ? "bg-purple-500/20 text-purple-300"
                  : "text-muted-foreground hover:bg-muted/30",
              )}
            >
              Form
            </button>
            <button
              onClick={() => setRawMode(true)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                rawMode
                  ? "bg-purple-500/20 text-purple-300"
                  : "text-muted-foreground hover:bg-muted/30",
              )}
            >
              Raw
            </button>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg",
              "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
              "border border-purple-500/20 transition-colors",
              loading && "opacity-50",
            )}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!snapshot?.valid && snapshot?.exists && (
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm">
          Config file exists but is invalid. Use Raw mode to fix it.
        </div>
      )}

      {snapshot && (
        rawMode ? (
          <ConfigRawView
            draft={rawDraft}
            onDraftChange={setRawDraft}
            onSave={handleSave}
            onRevert={() => {
              if (snapshot.raw) setRawDraft(snapshot.raw);
            }}
            saving={saving}
            baseHash={snapshot.baseHash ?? ""}
          />
        ) : (
          <ConfigFormView
            snapshot={snapshot}
            onSave={handleSave}
            saving={saving}
          />
        )
      )}
    </div>
  );
}
