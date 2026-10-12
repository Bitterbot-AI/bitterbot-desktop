/**
 * Browser-first onboarding (PLAN-56 Phase 4): the `/setup` route.
 *
 * `bitterbot onboard` prints and opens `http://127.0.0.1:<port>/setup?token=...`.
 * This page connects with that setup token (wizard scope only; it
 * cannot read config, chat or anything else), runs `wizard.start` and renders
 * each step the gateway sends until `wizard.next` says done. The same steps
 * run in the terminal (`bitterbot onboard --no-browser`): one step model,
 * two renderers.
 *
 * Without a setup link (setup already done) the page signs in the normal
 * Control UI way, as admin, and the gateway lets an admin re-run setup. When
 * the gateway refuses the setup link this tab kept (spent, expired, replaced
 * by a newer one), the page forgets it and falls back to that admin sign-in.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient, GatewayRequestError } from "../../lib/gateway-client";
import { readStoredGatewayToken } from "../../lib/gateway-origin";
import {
  forgetSetupToken,
  setupBasePath,
  setupGatewayWsUrl,
  takeSetupToken,
} from "../../lib/setup-route";
import { Button } from "../ui/button";
import { type SetupStep, SetupStepView } from "./SetupStepView";

type NextResult = {
  sessionId?: string;
  done: boolean;
  status?: "running" | "done" | "cancelled" | "error";
  step?: SetupStep;
  error?: string;
};

type Phase = "connecting" | "running" | "done" | "cancelled" | "error";

type ServiceInfo = {
  state: "installed" | "existing" | "failed" | "declined" | "unavailable";
  label?: string;
  error?: string;
};

type DoneInfo = { channelsNext?: boolean; restart?: boolean; service?: ServiceInfo };

/** Steps can wait on a real model turn and the doctor summary. */
const STEP_TIMEOUT_MS = 240_000;

export type SetupWizardProps = {
  /** Test seam: build the gateway client. */
  createClient?: (
    opts: ConstructorParameters<typeof GatewayClient>[0],
  ) => Pick<GatewayClient, "start" | "stop" | "request">;
  /** Test seam: the admin token when there is no setup link. */
  resolveAdminToken?: (basePath: string) => Promise<string | null>;
  location?: Location;
};

async function fetchAdminToken(basePath: string): Promise<string | null> {
  const stored = readStoredGatewayToken();
  if (stored) {
    return stored;
  }
  try {
    const res = await fetch(`${window.location.origin}${basePath}/auth/session-token`, {
      credentials: "omit",
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

function explain(err: unknown): string {
  const message =
    err instanceof GatewayRequestError || err instanceof Error ? err.message : String(err);
  if (/expired|no longer valid|not valid/.test(message)) {
    return `${message}. Run \`bitterbot onboard\` again for a fresh link.`;
  }
  return message;
}

export function SetupWizard({ createClient, resolveAdminToken, location }: SetupWizardProps) {
  const loc = location ?? window.location;
  const basePath = setupBasePath(loc.pathname);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [step, setStep] = useState<SetupStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneInfo, setDoneInfo] = useState<DoneInfo>({});
  const clientRef = useRef<Pick<GatewayClient, "start" | "stop" | "request"> | null>(null);
  const sessionRef = useRef<string | null>(null);
  const lastDataRef = useRef<unknown>(null);

  const apply = useCallback((result: NextResult) => {
    if (result.sessionId) {
      sessionRef.current = result.sessionId;
    }
    if (result.done) {
      setStep(null);
      if (result.status === "done") {
        const last = lastDataRef.current as (DoneInfo & { kind?: string }) | null;
        setDoneInfo(last?.kind === "done" ? last : {});
        setPhase("done");
        forgetSetupToken();
        // The setup token is spent; stop reconnect attempts with it.
        clientRef.current?.stop();
      } else if (result.status === "cancelled") {
        setPhase("cancelled");
      } else {
        setPhase("error");
        setError(result.error ?? "setup stopped");
      }
      return;
    }
    lastDataRef.current = result.step?.data ?? null;
    setStep(result.step ?? null);
    setPhase("running");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const make: NonNullable<SetupWizardProps["createClient"]> =
      createClient ?? ((opts) => new GatewayClient(opts));

    const connectAsAdmin = async (refusal?: string) => {
      const adminToken = await (resolveAdminToken ?? fetchAdminToken)(basePath);
      if (cancelled) {
        return;
      }
      if (refusal && !adminToken) {
        // No admin sign-in here (another machine): say why the link failed.
        setPhase("error");
        setError(explain(new Error(refusal)));
        return;
      }
      connect({ token: adminToken ?? undefined });
    };

    const connect = (auth: { setupToken: string } | { token?: string }) => {
      const viaSetupToken = "setupToken" in auth;
      let started = false;
      // The setup link was refused: forget it, sign in as admin instead.
      const refused = (message: string) => {
        clientRef.current?.stop();
        forgetSetupToken();
        void connectAsAdmin(message);
      };
      const client = make({
        url: setupGatewayWsUrl(loc),
        clientName: "bitterbot-control-ui",
        ...(viaSetupToken ? { setupToken: auth.setupToken, scopes: ["operator.setup"] } : auth),
        defaultRequestTimeoutMs: STEP_TIMEOUT_MS,
        onHello: () => {
          if (started || cancelled) {
            return;
          }
          started = true;
          clientRef.current
            ?.request<NextResult>("wizard.start", {}, { timeoutMs: STEP_TIMEOUT_MS })
            .then((result) => !cancelled && apply(result))
            .catch((err: unknown) => {
              if (cancelled) {
                return;
              }
              const message = explain(err);
              if (viaSetupToken && /already completed|expired|no longer valid/.test(message)) {
                refused(message);
                return;
              }
              setPhase("error");
              setError(message);
            });
        },
        onClose: ({ code, reason }) => {
          if (cancelled || started) {
            return;
          }
          // Refused at connect (expired or spent link, wrong address): retrying
          // with the same link cannot help.
          if (code === 1008 || (reason && reason !== "connect failed")) {
            const message = reason || "the gateway refused this setup link";
            if (viaSetupToken) {
              refused(message);
              return;
            }
            clientRef.current?.stop();
            setPhase("error");
            setError(explain(new Error(message)));
          }
        },
      });
      clientRef.current = client;
      client.start();
    };

    const setupToken = takeSetupToken(loc, window.history);
    if (setupToken) {
      connect({ setupToken });
    } else {
      void connectAsAdmin();
    }
    return () => {
      cancelled = true;
      clientRef.current?.stop();
      clientRef.current = null;
    };
    // Mount once: the link is read and removed from the URL on first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = useCallback(
    async (value: unknown) => {
      const client = clientRef.current;
      const sessionId = sessionRef.current;
      if (!client || !sessionId || !step) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await client.request<NextResult>(
          "wizard.next",
          { sessionId, answer: { stepId: step.id, value } },
          { timeoutMs: STEP_TIMEOUT_MS },
        );
        apply(result);
      } catch (err) {
        setError(explain(err));
      } finally {
        setBusy(false);
      }
    },
    [apply, step],
  );

  const cancel = useCallback(async () => {
    const sessionId = sessionRef.current;
    if (!clientRef.current || !sessionId) {
      return;
    }
    await clientRef.current.request("wizard.cancel", { sessionId }).catch(() => undefined);
    setPhase("cancelled");
  }, []);

  const controlUiHref = `${basePath}/`;

  return (
    <div className="min-h-screen flex items-start justify-center bg-background text-foreground px-6 py-12">
      <div className="w-full max-w-xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Set up Bitterbot</h1>
          <p className="text-sm text-muted-foreground">
            Everything stays on this machine. You can change any of this later in Settings.
          </p>
        </header>

        {phase === "connecting" ? (
          <p className="text-sm text-muted-foreground" data-testid="setup-connecting">
            Connecting to your gateway...
          </p>
        ) : null}

        {phase === "running" && step ? (
          <div className="rounded-lg border p-5" aria-busy={busy}>
            <SetupStepView step={step} busy={busy} onAnswer={(v) => void answer(v)} />
            {busy ? (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="setup-working">
                Working (a first reply can take a little while)...
              </p>
            ) : null}
          </div>
        ) : null}

        {phase === "done" ? (
          <div className="rounded-lg border p-5 space-y-3" data-testid="setup-done">
            <h2 className="text-lg font-semibold">You're set up</h2>
            {doneInfo.service?.state === "installed" ? (
              <p className="text-sm" data-testid="setup-service">
                Bitterbot now runs in the background as a {doneInfo.service.label} and starts on
                login.
              </p>
            ) : doneInfo.service?.state === "existing" ? (
              <p className="text-sm" data-testid="setup-service">
                Bitterbot runs in the background as a {doneInfo.service.label}.
              </p>
            ) : doneInfo.service?.state === "failed" ? (
              <p className="text-sm text-destructive" data-testid="setup-service">
                The background service could not be installed ({doneInfo.service.error}). Bitterbot
                runs only while this gateway process runs; try{" "}
                <code>bitterbot gateway install</code>.
              </p>
            ) : doneInfo.service?.state === "declined" ? (
              <p className="text-sm text-muted-foreground" data-testid="setup-service">
                Not running as a background service; start it with <code>bitterbot gateway</code>.
              </p>
            ) : null}
            {doneInfo.restart ? (
              <p className="text-sm text-muted-foreground">
                The gateway restarts once to apply the last settings; give it a few seconds.
              </p>
            ) : null}
            {doneInfo.channelsNext ? (
              <p className="text-sm">Next: open Channels in the sidebar to connect a chat app.</p>
            ) : null}
            <Button asChild>
              <a href={controlUiHref}>Open the Control UI</a>
            </Button>
          </div>
        ) : null}

        {phase === "cancelled" ? (
          <p className="text-sm" data-testid="setup-cancelled">
            Setup cancelled. Reload this page to start again.
          </p>
        ) : null}

        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
            data-testid="setup-error"
          >
            {error}
          </div>
        ) : null}

        {phase === "running" ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => void cancel()}
            disabled={busy}
          >
            Cancel setup
          </button>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Prefer the terminal? Run <code>bitterbot onboard --no-browser</code>.
        </p>
      </div>
    </div>
  );
}
