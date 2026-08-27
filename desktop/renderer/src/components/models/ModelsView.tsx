import { Check, ChevronDown, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  groupCatalogByProvider,
  type ProviderAuthStatus,
  useModelsStore,
} from "../../stores/models-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { useConfirm } from "../ui/confirm-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { KeyEntryModal } from "./KeyEntryModal";

/**
 * Models & Keys settings panel: node default model picker, per-provider
 * credential status with which-source-wins provenance, add/rotate/test/
 * delete keys - all live over models.* RPCs, no gateway restart.
 */
export function ModelsView() {
  const [confirmDialog, confirmElement] = useConfirm();
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const catalog = useModelsStore((s) => s.catalog);
  const catalogLoading = useModelsStore((s) => s.catalogLoading);
  const authStatus = useModelsStore((s) => s.authStatus);
  const authLoading = useModelsStore((s) => s.authLoading);
  const defaultModel = useModelsStore((s) => s.defaultModel);
  const loadCatalog = useModelsStore((s) => s.loadCatalog);
  const loadAuthStatus = useModelsStore((s) => s.loadAuthStatus);
  const loadDefaultModel = useModelsStore((s) => s.loadDefaultModel);
  const setDefaultModel = useModelsStore((s) => s.setDefaultModel);
  const testKey = useModelsStore((s) => s.testKey);
  const deleteProfile = useModelsStore((s) => s.deleteProfile);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalProvider, setModalProvider] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);

  const methods = hello?.features?.methods;
  const authSupported = methods ? methods.includes("models.auth.list") : true;
  const setDefaultSupported = methods ? methods.includes("models.setDefault") : true;

  useEffect(() => {
    if (status !== "connected") return;
    void loadCatalog();
    void loadDefaultModel();
    if (authSupported) void loadAuthStatus();
  }, [status, authSupported, loadCatalog, loadDefaultModel, loadAuthStatus]);

  const handleSetDefault = async (ref: string) => {
    setPickerOpen(false);
    setSettingDefault(true);
    try {
      await setDefaultModel(ref);
      toast.success("Default model updated", {
        description: `${ref} applies to new turns immediately.`,
      });
    } catch {
      // Central toast reports the failure.
    } finally {
      setSettingDefault(false);
    }
  };

  const handleProbeStored = async (provider: string) => {
    setProbing(provider);
    try {
      const result = await testKey({ provider });
      if (result.ok) {
        toast.success(`${provider}: credential verified`, {
          description: result.error,
        });
      } else {
        toast.error(`${provider}: verification failed`, {
          description: result.error ?? "The provider rejected the stored credential.",
        });
      }
    } catch {
      // Central toast covers transport failures.
    } finally {
      setProbing(null);
    }
  };

  const handleDelete = async (profileId: string) => {
    if (
      !(await confirmDialog({
        title: `Delete credential profile "${profileId}"?`,
        description: "This cannot be undone.",
        actionLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await deleteProfile(profileId);
      toast.success(`Deleted ${profileId}`);
    } catch {
      // Central toast covers it.
    }
  };

  const openModal = (provider?: string) => {
    setModalProvider(provider);
    setModalOpen(true);
  };

  const groups = groupCatalogByProvider(catalog);
  const configured = authStatus.filter((p) => p.winningSource !== null);
  const unconfigured = authStatus.filter((p) => p.winningSource === null);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {confirmElement}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Models &amp; Keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Switch the default model and manage provider credentials. Changes apply live.
          </p>
        </div>
        <Button size="sm" onClick={() => openModal()}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add key
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Default model</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                disabled={!setDefaultSupported || settingDefault || status !== "connected"}
                className="h-8 px-3 text-sm rounded-md border border-border bg-muted/40 hover:bg-muted inline-flex items-center gap-2 disabled:opacity-60"
              >
                {settingDefault ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="truncate max-w-[320px]">{defaultModel ?? "unknown"}</span>
                )}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[340px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search models…" />
                <CommandList>
                  <CommandEmpty>
                    {catalog.length > 0
                      ? "No models match."
                      : catalogLoading
                        ? "Loading catalog…"
                        : "Catalog unavailable - close and reopen to retry."}
                  </CommandEmpty>
                  {groups.map(([provider, entries]) => (
                    <CommandGroup key={provider} heading={provider}>
                      {entries.map((entry) => {
                        const ref = `${entry.provider}/${entry.id}`;
                        return (
                          <CommandItem
                            key={ref}
                            value={`${ref} ${entry.name}`}
                            onSelect={() => void handleSetDefault(ref)}
                          >
                            <Check
                              className={`h-3.5 w-3.5 mr-2 ${defaultModel === ref ? "opacity-100" : "opacity-0"}`}
                            />
                            <span className="truncate">{entry.name || entry.id}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <span className="text-xs text-muted-foreground">
            Used by every session without an override.
          </span>
        </CardContent>
      </Card>

      {!authSupported ? (
        <p className="text-sm text-muted-foreground">
          This gateway build does not support key management over RPC yet. Update the gateway to
          manage credentials from here.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Providers</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void loadAuthStatus()}
              disabled={authLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${authLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {authStatus.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {authLoading ? "Loading provider status…" : "No providers found."}
            </p>
          )}

          <div className="space-y-2">
            {[...configured, ...unconfigured].map((p) => (
              <ProviderRow
                key={p.provider}
                status={p}
                probing={probing === p.provider}
                onAddKey={() => openModal(p.provider)}
                onProbe={() => void handleProbeStored(p.provider)}
                onDelete={(profileId) => void handleDelete(profileId)}
              />
            ))}
          </div>
        </>
      )}

      <KeyEntryModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        provider={modalProvider}
        onSaved={() => void loadAuthStatus()}
      />
    </div>
  );
}

function ProviderRow({
  status,
  probing,
  onAddKey,
  onProbe,
  onDelete,
}: {
  status: ProviderAuthStatus;
  probing: boolean;
  onAddKey: () => void;
  onProbe: () => void;
  onDelete: (profileId: string) => void;
}) {
  const hasCredentials = status.winningSource !== null;
  const shadowedEnv =
    status.envPresent && status.winningSource !== null && !status.winningSource.startsWith("env");

  return (
    <Card className={hasCredentials ? "" : "opacity-70"}>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{status.provider}</span>
            {status.envPresent && <Badge variant="outline">env</Badge>}
            {status.configKeyPresent && <Badge variant="outline">config</Badge>}
            {!hasCredentials && <Badge variant="secondary">no key</Badge>}
          </div>
          <div className="flex items-center gap-1">
            {hasCredentials && (
              <Button size="sm" variant="ghost" onClick={onProbe} disabled={probing}>
                {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onAddKey}>
              <Plus className="h-3 w-3 mr-1" />
              {hasCredentials ? "Rotate" : "Add key"}
            </Button>
          </div>
        </div>

        {hasCredentials && (
          <p className="text-xs text-muted-foreground">
            Active source: <span className="font-mono">{status.winningSource}</span>
            {shadowedEnv && (
              <span className="text-amber-400">
                {" "}
                - a stored profile is shadowing {status.envSource}; delete the profile to fall back.
              </span>
            )}
          </p>
        )}

        {status.profiles.length > 0 && (
          <div className="space-y-1">
            {status.profiles.map((profile) => (
              <div
                key={profile.profileId}
                className="flex items-center justify-between text-xs rounded border border-border/50 px-2 py-1"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate">{profile.profileId}</span>
                  <Badge variant="outline">{profile.type}</Badge>
                  {profile.inCooldown && <Badge variant="destructive">cooldown</Badge>}
                  {profile.disabledUntil && <Badge variant="destructive">disabled</Badge>}
                </div>
                <button
                  onClick={() => onDelete(profile.profileId)}
                  className="text-muted-foreground hover:text-red-400 transition-colors p-1"
                  title={`Delete ${profile.profileId}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
