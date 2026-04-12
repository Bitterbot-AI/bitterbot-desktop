/**
 * FirstRun — onboarding surface for Control UI users who don't yet
 * have a gateway token configured.
 *
 * Shows instead of <AppShell> when `readStoredGatewayToken()` returns
 * null (no localStorage entry AND no build-time VITE_GATEWAY_TOKEN).
 * Lets the user:
 *
 *   1. Understand what they're about to connect to
 *   2. Paste a gateway URL + token (with instructions to get them from
 *      `pnpm bitterbot onboard` or ~/.bitterbot/bitterbot.json)
 *   3. Test the connection live — the store spins up a real GatewayClient
 *      with the user-entered credentials and reports back in ~1s
 *   4. On success, persist to localStorage and reload into AppShell
 *
 * This is a bridge, not a replacement for the CLI onboarding wizard.
 * Full agent setup (API keys, auth profiles, workspace, channels) still
 * requires `pnpm bitterbot onboard` in a terminal — FirstRun just
 * handles the final "now connect the browser UI to the running gateway"
 * mile when the wizard didn't generate desktop/.env for whatever reason.
 */

import { useEffect, useState } from "react";
import {
  persistGatewayCredentials,
  readStoredGatewayUrl,
  useGatewayStore,
} from "../../stores/gateway-store";

type Phase = "idle" | "testing" | "success" | "failed";

export function FirstRun({ onComplete }: { onComplete: () => void }) {
  const [url, setUrl] = useState(() => readStoredGatewayUrl());
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const status = useGatewayStore((s) => s.status);
  const storeError = useGatewayStore((s) => s.error);
  const connect = useGatewayStore((s) => s.connect);
  const disconnect = useGatewayStore((s) => s.disconnect);

  // Watch store status while testing. When we see "connected" the
  // credentials are good. If we see "disconnected" with an error (and
  // we were testing), surface it. Anything else is transient.
  useEffect(() => {
    if (phase !== "testing") return;
    if (status === "connected") {
      setPhase("success");
      setErrorMsg(null);
      persistGatewayCredentials({ url, token });
      // Give the user a beat to see the success state, then hand off
      // to AppShell. The store is already connected, so no re-dial
      // is needed on the other side.
      const handoff = setTimeout(() => onComplete(), 600);
      return () => clearTimeout(handoff);
    }
    if (status === "disconnected" && storeError) {
      setPhase("failed");
      setErrorMsg(storeError);
    }
  }, [phase, status, storeError, url, token, onComplete]);

  // If the user cancels mid-test, stop the client.
  useEffect(() => {
    return () => {
      if (phase === "testing") disconnect();
    };
  }, [phase, disconnect]);

  const handleTest = () => {
    if (!url.trim() || !token.trim()) {
      setErrorMsg("Enter both a gateway URL and a token.");
      return;
    }
    setErrorMsg(null);
    setPhase("testing");
    connect(url.trim(), token.trim());
  };

  const handleReset = () => {
    disconnect();
    setPhase("idle");
    setErrorMsg(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground px-6">
      <div className="w-full max-w-xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Connect to your Bitterbot gateway</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The Control UI needs a running Bitterbot gateway and an auth token to connect. If you
            already ran <code className="px-1 py-0.5 bg-muted rounded">pnpm bitterbot onboard</code>
            , the wizard should have saved your token to{" "}
            <code className="px-1 py-0.5 bg-muted rounded">desktop/.env</code> automatically — if
            you're seeing this screen, that file is missing or this browser doesn't have it cached.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Start the gateway in a terminal with <code className="px-1 py-0.5 bg-muted rounded">pnpm start gateway</code>, then paste your token below. You can find it at{" "}
            <code className="px-1 py-0.5 bg-muted rounded">~/.bitterbot/bitterbot.json → gateway.auth.token</code>.
          </p>
        </header>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            handleTest();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="gateway-url" className="text-sm font-medium">
              Gateway URL
            </label>
            <input
              id="gateway-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={phase === "testing" || phase === "success"}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              placeholder="ws://127.0.0.1:19001"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="gateway-token" className="text-sm font-medium">
              Gateway token
            </label>
            <input
              id="gateway-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={phase === "testing" || phase === "success"}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              placeholder="paste from ~/.bitterbot/bitterbot.json"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {errorMsg ? (
            <div className="px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-sm text-red-400">
              {errorMsg}
            </div>
          ) : null}

          {phase === "testing" ? (
            <div className="px-3 py-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-sm text-yellow-400">
              Testing connection…
            </div>
          ) : null}

          {phase === "success" ? (
            <div className="px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-400">
              Connected. Loading Control UI…
            </div>
          ) : null}

          <div className="flex gap-3 pt-2">
            {phase === "failed" ? (
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 rounded-md border border-border bg-muted text-sm font-medium hover:bg-muted/80"
              >
                Try again
              </button>
            ) : (
              <button
                type="submit"
                disabled={phase === "testing" || phase === "success"}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {phase === "testing" ? "Testing…" : "Connect"}
              </button>
            )}
          </div>
        </form>

        <footer className="text-xs text-muted-foreground border-t border-border/40 pt-4 space-y-1">
          <p>
            Need to start the gateway?{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-[11px]">pnpm start gateway</code>{" "}
            or{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-[11px]">pnpm dev:all</code>{" "}
            (spawns gateway + Control UI in one terminal).
          </p>
          <p>
            Don't have a token yet?{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-[11px]">pnpm bitterbot onboard</code>{" "}
            walks you through full setup and auto-generates <code className="px-1 py-0.5 bg-muted rounded text-[11px]">desktop/.env</code>.
          </p>
        </footer>
      </div>
    </div>
  );
}
