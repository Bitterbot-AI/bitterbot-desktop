import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig } from "../config/config.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import { isBrowserStarting } from "./launch-activity.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";

type LoopbackBrowserAuthDeps = {
  loadConfig: typeof loadConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-bitterbot-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.loadConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-bitterbot-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const parsed = new URL(url);
    const port =
      parsed.port && Number.parseInt(parsed.port, 10) > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-bitterbot-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    loadConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

/**
 * The control service answered, and the answer was an error: an element that
 * is not there, a tab that closed, a browser that failed to start. The request
 * arrived. Its message is the diagnosis and is passed on as it is.
 */
export class BrowserResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrowserResponseError";
  }
}

/** A control-service error body is `{ error: "..." }`; show the message, not the JSON. */
function responseErrorMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error) {
      return parsed.error;
    }
  } catch {
    // not JSON
  }
  return text || `HTTP ${status}`;
}

/**
 * Wording for a request that got NO answer. It used to cover every failure,
 * including ordinary error responses, and always said the control service was
 * unreachable and the gateway needed a restart. On 2026-10-02 that sent a
 * person to restart a healthy gateway when the cause was a browser binary that
 * could not launch. The local service runs inside the gateway process: if this
 * code is running, the service is too.
 */
function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  if (err instanceof BrowserResponseError) {
    return err;
  }
  const isLocal = !isAbsoluteHttp(url);
  // Model-facing suffix: explicitly tell the LLM NOT to retry.
  // Without this, models see "try again" and enter an infinite tool-call loop.
  const modelHint =
    "Do NOT retry the browser tool — it will keep failing. " +
    "Use an alternative approach or inform the user that the browser is currently unavailable.";
  const msg = err instanceof Error ? err.message : String(err);
  const msgLower = msg.toLowerCase();
  const looksLikeTimeout =
    msgLower.includes("timed out") ||
    msgLower.includes("timeout") ||
    msgLower.includes("aborted") ||
    msgLower.includes("abort") ||
    msgLower.includes("aborterror");

  if (isLocal) {
    const statusHint = `Check it with \`${formatCliCommand("bitterbot browser status")}\`.`;
    if (looksLikeTimeout && isBrowserStarting()) {
      // Not a broken browser: a cold start that outlasted this call. Telling
      // the model never to retry here made it give up on a browser that was
      // ready a moment later.
      return new Error(
        `The browser was still starting when this call gave up after ${timeoutMs}ms ` +
          "(a cold start can take 20 to 30 seconds). It should be ready now or very shortly: " +
          "try this call ONE more time. If that fails too, do not keep retrying; " +
          `tell the user the browser is unavailable. ${statusHint}`,
      );
    }
    if (looksLikeTimeout) {
      return new Error(
        `The browser did not respond within ${timeoutMs}ms. It may have failed to start, ` +
          `or be stuck on a slow page. ${statusHint} ${modelHint}`,
      );
    }
    return new Error(`The browser request failed: ${msg}. ${statusHint} ${modelHint}`);
  }

  const operatorHint = "If this is a sandboxed session, ensure the sandbox browser is running.";
  if (looksLikeTimeout) {
    return new Error(
      `Can't reach the Bitterbot browser control service (timed out after ${timeoutMs}ms). ${operatorHint} ${modelHint}`,
    );
  }
  return new Error(
    `Can't reach the Bitterbot browser control service. ${operatorHint} ${modelHint} (${msg})`,
  );
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error("timed out")), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BrowserResponseError(responseErrorMessage(text, res.status), res.status);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    if (isAbsoluteHttp(url)) {
      const httpInit = withLoopbackBrowserAuth(url, init);
      return await fetchHttpJson<T>(url, { ...httpInit, timeoutMs });
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }

    const abortCtrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAbortListener: (() => void) | undefined;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        abortCtrl.abort(upstreamSignal.reason);
      } else {
        upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
      }
    }

    let abortListener: (() => void) | undefined;
    const abortPromise: Promise<never> = abortCtrl.signal.aborted
      ? Promise.reject(abortCtrl.signal.reason ?? new Error("aborted"))
      : new Promise((_, reject) => {
          abortListener = () => reject(abortCtrl.signal.reason ?? new Error("aborted"));
          abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => abortCtrl.abort(new Error("timed out")), timeoutMs);
    }

    const dispatchPromise = dispatcher.dispatch({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
      signal: abortCtrl.signal,
    });

    const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        abortCtrl.signal.removeEventListener("abort", abortListener);
      }
      if (upstreamSignal && upstreamAbortListener) {
        upstreamSignal.removeEventListener("abort", upstreamAbortListener);
      }
    });

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`;
      throw new BrowserResponseError(message, result.status);
    }
    return result.body as T;
  } catch (err) {
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}

export const __test = {
  withLoopbackBrowserAuth: withLoopbackBrowserAuthImpl,
};
