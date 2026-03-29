import { useGatewayStore } from "../../stores/gateway-store";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../lib/format";

type ClientInstance = {
  id: string;
  clientId?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  connectedAt?: number;
  remoteIp?: string;
  [key: string]: unknown;
};

export function InstancesView() {
  const hello = useGatewayStore((s) => s.hello);

  const instances: ClientInstance[] = Array.isArray(hello?.instances)
    ? (hello.instances as ClientInstance[])
    : [];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Instances</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connected client instances
        </p>
      </div>

      {instances.length === 0 ? (
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-8 text-center">
          <p className="text-muted-foreground">
            No instance data available. Instance tracking requires the gateway
            to report connected clients in the hello snapshot.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/20">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">
                  Client
                </th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">
                  Platform
                </th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">
                  Version
                </th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">
                  Connected
                </th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">
                  IP
                </th>
              </tr>
            </thead>
            <tbody>
              {instances.map((inst, i) => (
                <tr
                  key={inst.id ?? i}
                  className={cn(
                    "border-b border-border/10 last:border-0",
                    "hover:bg-muted/20 transition-colors",
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">
                      {inst.displayName ?? inst.clientId ?? inst.id}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {inst.platform ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                    {inst.version ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {inst.connectedAt
                      ? formatRelativeTime(inst.connectedAt)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                    {inst.remoteIp ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
