import { Check, ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { groupCatalogByProvider, useModelsStore } from "../../stores/models-store";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/**
 * Chat-header model switcher. Reads the session's effective model, lists the
 * gateway's model catalog grouped by provider, and applies a per-session
 * override via sessions.patch — live, no gateway restart. "Default" clears
 * the override so the session follows the node's configured default again.
 */
export function ModelPicker() {
  const sessionKey = useChatStore((s) => s.sessionKey);
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const catalog = useModelsStore((s) => s.catalog);
  const catalogLoading = useModelsStore((s) => s.catalogLoading);
  const loadCatalog = useModelsStore((s) => s.loadCatalog);
  const loadSessionModel = useModelsStore((s) => s.loadSessionModel);
  const setSessionModel = useModelsStore((s) => s.setSessionModel);
  const current = useModelsStore((s) => s.sessionModels[sessionKey]);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Version skew: older gateways advertise their methods in the hello frame.
  // Without both RPCs the picker can't work, so render nothing.
  const methods = hello?.features?.methods;
  const supported = methods
    ? methods.includes("models.list") && methods.includes("sessions.patch")
    : true;

  useEffect(() => {
    if (!supported || status !== "connected") return;
    void loadSessionModel(sessionKey);
  }, [supported, status, sessionKey, loadSessionModel]);

  useEffect(() => {
    if (!supported || !open || status !== "connected") return;
    void loadCatalog();
  }, [supported, open, status, loadCatalog]);

  if (!supported) return null;

  const handleSelect = async (modelRef: string | null) => {
    setOpen(false);
    setSaving(true);
    try {
      await setSessionModel(sessionKey, modelRef);
    } catch {
      // Failure lands in the central gateway-store toast; re-read the
      // server's view so the pill never shows a model that didn't apply.
      void loadSessionModel(sessionKey);
    } finally {
      setSaving(false);
    }
  };

  const label = current?.model ?? "model";
  const groups = groupCatalogByProvider(catalog);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={saving || status !== "connected"}
          className={cn(
            "h-6 px-2 text-xs rounded-md inline-flex items-center gap-1",
            "border transition-colors truncate max-w-[240px]",
            current?.overridden
              ? "bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20"
              : "bg-muted/40 text-muted-foreground border-border hover:bg-muted",
            (saving || status !== "connected") && "opacity-60",
          )}
          title={
            current
              ? `Model: ${current.provider}/${current.model}${current.overridden ? " (session override)" : " (default)"}`
              : "Switch model"
          }
        >
          <span className="truncate">{saving ? "switching…" : label}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="end">
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
            {current?.overridden && (
              <>
                <CommandGroup>
                  <CommandItem value="__default__" onSelect={() => void handleSelect(null)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-2" />
                    Reset to default
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {groups.map(([provider, entries]) => (
              <CommandGroup key={provider} heading={provider}>
                {entries.map((entry) => {
                  const isCurrent =
                    current?.model === entry.id && current?.provider === entry.provider;
                  return (
                    <CommandItem
                      key={`${entry.provider}/${entry.id}`}
                      value={`${entry.provider}/${entry.id} ${entry.name}`}
                      onSelect={() => void handleSelect(`${entry.provider}/${entry.id}`)}
                    >
                      <Check
                        className={cn("h-3.5 w-3.5 mr-2", isCurrent ? "opacity-100" : "opacity-0")}
                      />
                      <span className="truncate">{entry.name || entry.id}</span>
                      {entry.reasoning && (
                        <span className="ml-auto text-2xs text-muted-foreground pl-2">
                          reasoning
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
