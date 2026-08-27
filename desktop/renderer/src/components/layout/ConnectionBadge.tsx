import { useGateway } from "../../hooks/useGateway";
import { cn } from "../../lib/utils";

export function ConnectionBadge() {
  const { status, error } = useGateway();

  const statusConfig = {
    disconnected: {
      label: "Disconnected",
      dotClass: "bg-danger",
      textClass: "text-danger",
    },
    connecting: {
      label: "Connecting...",
      dotClass: "bg-warning animate-pulse",
      textClass: "text-warning",
    },
    connected: {
      label: "Connected to Bitterbot Gateway",
      dotClass: "bg-success",
      textClass: "text-success",
    },
  }[status];

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs no-drag",
        "bg-background/50 border border-border/30",
        statusConfig.textClass,
      )}
      title={error ?? statusConfig.label}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", statusConfig.dotClass)} />
      <span>{statusConfig.label}</span>
    </div>
  );
}
