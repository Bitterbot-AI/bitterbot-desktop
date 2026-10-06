import { Plug, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

export type ConnectorStatus = {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  trustWrites: boolean;
  state: "connected" | "connecting" | "error" | "off" | "needs-sign-in";
  error?: string;
  signInUrl?: string;
  signedIn?: boolean;
  connectedAt?: number;
  tools: Array<{ name: string; readOnly: boolean; description?: string }>;
};

/** Plain words for a connector's state and what its tools can do. */
export function describeConnector(c: ConnectorStatus): { tone: string; text: string } {
  if (!c.enabled) return { tone: "text-muted-foreground/60", text: "Off" };
  if (c.state === "needs-sign-in") return { tone: "text-warning", text: "Needs you to sign in" };
  if (c.state === "error")
    return { tone: "text-danger", text: `Not connected: ${c.error ?? "unknown error"}` };
  if (c.state === "connecting") return { tone: "text-muted-foreground", text: "Connecting…" };
  const reads = c.tools.filter((t) => t.readOnly).length;
  const writes = c.tools.length - reads;
  const parts = [`${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}`];
  if (writes > 0) {
    parts.push(
      c.trustWrites
        ? `${writes} can change things without asking`
        : `${writes} that change things wait for your approval`,
    );
  }
  return { tone: "text-success", text: `Connected · ${parts.join(" · ")}` };
}

/**
 * Connectors (PLAN-53 D2, D4): MCP servers the agent can use. A local program
 * or a remote server; their tools reach the agent, and the ones that change
 * something wait for approval unless you trust that connector.
 */
export function ConnectorsView() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [servers, setServers] = useState<ConnectorStatus[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [target, setTarget] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useOAuth, setUseOAuth] = useState(false);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const res = (await request("mcp.list", {})) as { servers?: ConnectorStatus[] };
      setServers(res?.servers ?? []);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [status, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.error(label, { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !target.trim()) return;
    const [command, ...args] = target.trim().split(/\s+/);
    void run("Could not add the connector", async () => {
      await request("mcp.add", {
        name: name.trim(),
        transport: kind,
        ...(kind === "http"
          ? {
              url: target.trim(),
              ...(useOAuth ? { auth: "oauth" } : {}),
              ...(apiKey.trim() && !useOAuth
                ? { headers: { Authorization: `Bearer ${apiKey.trim()}` } }
                : {}),
            }
          : { command, args }),
      });
      setName("");
      setTarget("");
      setApiKey("");
    });
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Connectors</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Give your agent access to other services through MCP servers: a remote server by its
          address, or a program on this machine. Anything that changes something waits for your
          approval unless you trust that connector.
        </p>
      </div>

      {unavailable && (
        <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
          Connectors are not available on this gateway. Update it, or check that the "mcp" plugin is
          enabled.
        </div>
      )}

      {!unavailable && (
        <form
          onSubmit={add}
          className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3"
        >
          <h3 className="text-sm font-medium text-foreground">Add a connector</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. calendar"
              aria-label="Connector name"
              className="h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
            />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "http" | "stdio")}
              aria-label="Connector kind"
              className="h-8 px-2 text-sm rounded-lg border border-border/30 bg-transparent"
            >
              <option value="http">Remote server (address)</option>
              <option value="stdio">Program on this machine</option>
            </select>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={kind === "http" ? "https://…/mcp" : "npx -y some-mcp-server"}
              aria-label={kind === "http" ? "Server address" : "Command"}
              className="md:col-span-2 h-8 px-3 text-sm font-mono rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
            />
            {kind === "http" && (
              <label className="md:col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={useOAuth}
                  onChange={(e) => setUseOAuth(e.target.checked)}
                />
                This server needs me to sign in
              </label>
            )}
            {kind === "http" && !useOAuth && (
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder="API key (optional)"
                aria-label="API key"
                className="md:col-span-2 h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
              />
            )}
          </div>
          <button
            type="submit"
            disabled={busy || !name.trim() || !target.trim()}
            className="px-4 py-1.5 text-xs rounded-lg font-medium bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add connector
          </button>
        </form>
      )}

      {!unavailable && servers.length === 0 && (
        <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60">
          No connectors yet.
        </div>
      )}

      {servers.map((c) => {
        const state = describeConnector(c);
        return (
          <div
            key={c.name}
            className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4"
            data-testid="connector-card"
          >
            <div className="flex items-start gap-3">
              <Plug className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{c.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {c.transport === "http" ? "remote" : "local program"}
                  </span>
                </div>
                <p className={cn("text-xs mt-0.5 break-words", state.tone)}>{state.text}</p>
                {c.state === "needs-sign-in" && c.signInUrl && (
                  <a
                    href={c.signInUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block mt-1 px-3 py-1 text-xs rounded-lg font-medium bg-brand text-white hover:bg-brand/90"
                  >
                    Sign in to {c.name}
                  </a>
                )}
                {c.signedIn && (
                  <button
                    onClick={() =>
                      void run("Sign out failed", () => request("mcp.signOut", { name: c.name }))
                    }
                    className="block mt-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Sign out
                  </button>
                )}
                {c.connectedAt && (
                  <p className="text-2xs text-muted-foreground/60">
                    Connected {formatRelativeTime(c.connectedAt)}
                  </p>
                )}
                {c.tools.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-xs text-muted-foreground cursor-pointer">
                      Tools
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {c.tools.map((t) => (
                        <li key={t.name} className="text-xs">
                          <span className="font-mono text-foreground">{t.name}</span>
                          <span className="text-muted-foreground/70">
                            {" "}
                            · {t.readOnly ? "reads" : "changes things"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <label className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={c.trustWrites}
                    onChange={(e) =>
                      void run("Could not change the connector", () =>
                        request("mcp.update", {
                          name: c.name,
                          patch: { trustWrites: e.target.checked },
                        }),
                      )
                    }
                  />
                  Let this connector change things without asking
                </label>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() =>
                    void run("Reconnect failed", () => request("mcp.refresh", { name: c.name }))
                  }
                  title="Reconnect"
                  aria-label={`Reconnect ${c.name}`}
                  className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() =>
                    void run("Remove failed", () => request("mcp.remove", { name: c.name }))
                  }
                  title="Remove"
                  aria-label={`Remove ${c.name}`}
                  className="p-1.5 rounded text-danger hover:bg-danger/10"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
