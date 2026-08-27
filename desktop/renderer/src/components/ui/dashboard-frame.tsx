/**
 * PLAN-41 p0-14 (iframe-403): the server-rendered dashboards (/dreams,
 * /management) are only served to local-direct browsers. When the Control UI
 * itself is being viewed from somewhere the gateway won't serve them, the
 * iframe used to render a raw 403/401 page. Probe first (same-origin only —
 * a cross-origin probe from the Vite dev server would CORS-fail even though
 * the iframe works) and show an explanation instead of the bare error.
 */
import { useEffect, useMemo, useState } from "react";
import { resolveGatewayHttpOrigin } from "../../lib/gateway-origin";

type ProbeState = "probing" | "ok" | "blocked";

export function DashboardFrame({
  path,
  title,
  reloadKey,
}: {
  path: string;
  title: string;
  /** Bump to force an iframe refresh (e.g. on gateway reconnect). */
  reloadKey?: unknown;
}) {
  const src = useMemo(() => `${resolveGatewayHttpOrigin()}${path}`, [path]);
  const sameOrigin = useMemo(() => {
    try {
      return new URL(src).origin === window.location.origin;
    } catch {
      return false;
    }
  }, [src]);
  const [state, setState] = useState<ProbeState>(sameOrigin ? "probing" : "ok");

  useEffect(() => {
    if (!sameOrigin) {
      return;
    }
    let alive = true;
    setState("probing");
    fetch(src, { cache: "no-store" })
      .then((res) => {
        if (alive) {
          setState(res.ok ? "ok" : "blocked");
        }
      })
      .catch(() => {
        if (alive) {
          setState("blocked");
        }
      });
    return () => {
      alive = false;
    };
  }, [src, sameOrigin, reloadKey]);

  if (state === "probing") {
    return <div className="flex-1 p-8 text-sm text-muted-foreground">Loading {title}…</div>;
  }

  if (state === "blocked") {
    return (
      <div className="flex-1 p-8 max-w-lg space-y-3">
        <h2 className="text-lg font-semibold">{title} is only served to local browsers</h2>
        <p className="text-sm text-muted-foreground">
          The gateway refuses this dashboard for non-local viewers, and you are reading the Control
          UI from a non-local address. To see it:
        </p>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
          <li>
            open <code className="px-1 rounded bg-muted text-xs">http://127.0.0.1:19001{path}</code>{" "}
            in a browser on the node itself, or
          </li>
          <li>
            reach the node over Tailscale Serve with your host listed in{" "}
            <code className="px-1 rounded bg-muted text-xs">gateway.controlUi.allowedHosts</code>,
            or
          </li>
          <li>
            tunnel it:{" "}
            <code className="px-1 rounded bg-muted text-xs">ssh -L 19001:127.0.0.1:19001 …</code>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <iframe
      key={String(reloadKey ?? "")}
      src={src}
      className="flex-1 w-full border-0"
      title={title}
      allow="autoplay"
    />
  );
}
