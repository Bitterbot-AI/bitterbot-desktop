import { useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { useConfigStore, type ConfigSchema, type ConfigSnapshot } from "../../stores/config-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { SettingsForm } from "./SettingsForm";

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
  const schema = useConfigStore((s) => s.schema);
  const rawMode = useConfigStore((s) => s.rawMode);
  const rawDraft = useConfigStore((s) => s.rawDraft);
  const loading = useConfigStore((s) => s.loading);
  const saving = useConfigStore((s) => s.saving);
  const error = useConfigStore((s) => s.error);
  const setSnapshot = useConfigStore((s) => s.setSnapshot);
  const setSchema = useConfigStore((s) => s.setSchema);
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
    // The schema (uiHints + reload rules) drives the form; fetched once per
    // connect — it only changes when plugins/channels change (p0-15: this
    // wires the store's previously-empty schema slot).
    try {
      const schemaRes = (await request("config.schema", {})) as ConfigSchema;
      setSchema(schemaRes);
    } catch {
      /* form falls back to fewer rows; raw mode unaffected */
    }
  }, [gwStatus, request, setSnapshot, setRawDraft, setLoading, setError, setSchema]);

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

  const handlePatch = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setSaving(true);
      try {
        const res = (await request("config.patch", {
          raw: JSON.stringify(patch),
          baseHash: snapshot?.baseHash ?? "",
        })) as { ok?: boolean };
        setError(null);
        await refresh();
        return Boolean(res?.ok ?? true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [request, snapshot?.baseHash, refresh, setSaving, setError],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
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
              Raw JSON
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

      {snapshot &&
        (rawMode ? (
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
          <SettingsForm snapshot={snapshot} schema={schema} saving={saving} onPatch={handlePatch} />
        ))}
    </div>
  );
}
