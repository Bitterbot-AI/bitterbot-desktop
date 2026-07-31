import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type AuthProbeResult, useModelsStore } from "../../stores/models-store";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface KeyEntryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill the provider field (e.g. when opened from a provider row). */
  provider?: string;
  onSaved?: (profileId: string) => void;
}

/**
 * Add/rotate a provider credential with test-before-save. The secret is
 * write-only: it goes to models.auth.test / models.auth.set and is never
 * echoed back or stored client-side beyond this dialog's local state.
 */
export function KeyEntryModal({ open, onOpenChange, provider, onSaved }: KeyEntryModalProps) {
  const testKey = useModelsStore((s) => s.testKey);
  const saveKey = useModelsStore((s) => s.saveKey);

  const [providerDraft, setProviderDraft] = useState(provider ?? "");
  const [name, setName] = useState("");
  const [credentialType, setCredentialType] = useState<"api_key" | "token">("api_key");
  const [value, setValue] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<AuthProbeResult | null>(null);

  // Reset per open so a previous session's secret never lingers.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setValue("");
      setProbe(null);
      setName("");
      setTesting(false);
      setSaving(false);
    } else {
      setProviderDraft(provider ?? "");
    }
    onOpenChange(next);
  };

  const effectiveProvider = (provider ?? providerDraft).trim();
  const canSubmit = effectiveProvider.length > 0 && value.trim().length > 0;

  const handleTest = async () => {
    if (!canSubmit) return;
    setTesting(true);
    setProbe(null);
    try {
      const result = await testKey({ provider: effectiveProvider, apiKey: value });
      setProbe(result);
    } catch (err) {
      setProbe({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const { profileId } = await saveKey({
        provider: effectiveProvider,
        name: name.trim() || undefined,
        credentialType,
        value,
      });
      toast.success("Credential saved", {
        description: `${profileId} is active now - no restart needed.`,
      });
      onSaved?.(profileId);
      handleOpenChange(false);
    } catch {
      // Central toast reports the failure; keep the dialog open for retry.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{provider ? `Add key for ${provider}` : "Add provider key"}</DialogTitle>
          <DialogDescription>
            The key is sent to your gateway, verified live if possible, and stored in its auth
            profiles. It is never displayed again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!provider && (
            <div className="space-y-1">
              <Label htmlFor="key-provider">Provider</Label>
              <Input
                id="key-provider"
                value={providerDraft}
                onChange={(e) => setProviderDraft(e.target.value)}
                placeholder="anthropic, openai, groq, ..."
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="key-value">{credentialType === "token" ? "Token" : "API key"}</Label>
            <Input
              id="key-value"
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setProbe(null);
              }}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
          <div className="flex gap-3">
            <div className="space-y-1 flex-1">
              <Label htmlFor="key-name">Profile name (optional)</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="key-type">Type</Label>
              <select
                id="key-type"
                value={credentialType}
                onChange={(e) => setCredentialType(e.target.value as "api_key" | "token")}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                <option value="api_key">API key</option>
                <option value="token">Token</option>
              </select>
            </div>
          </div>

          {probe && (
            <div
              className={`flex items-start gap-2 text-sm rounded-md border p-2 ${
                probe.ok
                  ? "border-emerald-500/30 text-emerald-400"
                  : probe.unsupported
                    ? "border-amber-500/30 text-amber-400"
                    : "border-red-500/30 text-red-400"
              }`}
            >
              {probe.ok ? (
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              )}
              <span>
                {probe.ok
                  ? `Key verified${probe.error ? ` (${probe.error})` : ""}`
                  : (probe.error ?? "Verification failed")}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            disabled={!canSubmit || testing || saving}
          >
            {testing && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Test
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSubmit || saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
