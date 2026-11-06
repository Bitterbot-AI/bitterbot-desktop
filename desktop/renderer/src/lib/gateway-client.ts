/**
 * Gateway WebSocket client for the Bitterbot Control UI and the phone app.
 *
 * Authenticates with the shared gateway token (Control UI) or a per-device
 * token (phone), and, when a device identity is available, signs the
 * handshake with the device key (PLAN-62) so the gateway can bind scopes to a
 * paired device instead of stripping them.
 */

import { buildDeviceAuthPayload, type BrowserDeviceIdentity } from "./device-identity";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

/**
 * Structured rejection for any failed gateway request. Carries enough
 * context for the store layer to route toasts without every call site
 * having to construct the error itself.
 *
 *   - kind: "remote"     → gateway replied `{ ok: false, error: ... }`
 *   - kind: "timeout"    → no response within the deadline
 *   - kind: "disconnect" → socket closed or client stopped with the
 *                          request still in flight
 */
export type GatewayRequestErrorKind = "remote" | "timeout" | "disconnect";

export class GatewayRequestError extends Error {
  readonly method: string;
  readonly code: string | null;
  readonly kind: GatewayRequestErrorKind;
  readonly details?: unknown;

  constructor(params: {
    message: string;
    method: string;
    code?: string | null;
    kind: GatewayRequestErrorKind;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "GatewayRequestError";
    this.method = params.method;
    this.code = params.code ?? null;
    this.kind = params.kind;
    this.details = params.details;
  }
}

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
  // Common hello snapshot fields
  ts?: number;
  version?: string;
  instances?: unknown[];
  [key: string]: unknown;
};

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientVersion?: string;
  /**
   * PLAN-56 Phase 4: a one-time setup token from the setup link. The gateway
   * grants it the wizard RPCs only (scope operator.setup).
   */
  setupToken?: string;
  /** Scopes to request; the Control UI's operator scopes by default. */
  scopes?: string[];
  /**
   * PLAN-62: the browser's device key. When it resolves to an identity the
   * connect frame carries a signed `device` field; null keeps the old
   * deviceless handshake (insecure contexts, older gateways).
   */
  deviceIdentity?: () => Promise<BrowserDeviceIdentity | null>;
  /** PLAN-62: a per-device token (the phone's), sent instead of the gateway token. */
  deviceToken?: () => string | null;
  /** Shown in the Control UI's device list. */
  displayName?: string;
  clientMode?: string;
  /** Default per-request timeout in ms. Override per-call via request() options. */
  defaultRequestTimeoutMs?: number;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  /**
   * Fires whenever a request rejects for any reason (remote ok:false,
   * timeout, or disconnect mid-request). The store wires this to a
   * toast dispatcher so silent failures become visible. The original
   * Promise rejection still propagates, so per-call-site handling
   * (retry, fallback, etc.) keeps working unchanged.
   */
  onRequestError?: (err: GatewayRequestError) => void;
};

// Requests that typically take a while and should not be force-killed
// by the default 30s timeout (model prompts, long tool calls). Callers
// can still pass an explicit timeoutMs to override per-call.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

let idCounter = 0;
function nextId(): string {
  return `req-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private backoffMs = 800;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: GatewayClientOptions) {}

  start() {
    this.closed = false;
    this.doConnect();
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get url(): string {
    return this.opts.url;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const err = new GatewayRequestError({
        message: "gateway not connected",
        method,
        kind: "disconnect",
      });
      this.opts.onRequestError?.(err);
      return Promise.reject(err);
    }
    const id = nextId();
    const frame = { type: "req", id, method, params };
    const timeoutMs =
      options?.timeoutMs ?? this.opts.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const p = new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const pending = this.pending.get(id);
              if (!pending) {
                return;
              }
              this.pending.delete(id);
              const err = new GatewayRequestError({
                message: `request "${method}" timed out after ${timeoutMs}ms`,
                method,
                kind: "timeout",
              });
              this.opts.onRequestError?.(err);
              reject(err);
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        method,
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  private doConnect() {
    if (this.closed) return;

    this.ws = new WebSocket(this.opts.url);

    this.ws.addEventListener("open", () => {
      this.queueConnect();
    });

    this.ws.addEventListener("message", (ev) => {
      this.handleMessage(String(ev.data ?? ""));
    });

    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      this.ws = null;
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason });
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // close handler will fire
    });
  }

  private sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    void this.buildAndSendConnect();
  }

  private async buildAndSendConnect() {
    const clientId = this.opts.clientName ?? "bitterbot-desktop";
    const clientMode = this.opts.clientMode ?? "ui";
    const role = "operator";
    const scopes = this.opts.scopes ?? ["operator.admin", "operator.approvals", "operator.pairing"];
    const deviceToken = this.opts.deviceToken?.() ?? null;
    const auth = this.opts.setupToken
      ? { setupToken: this.opts.setupToken }
      : deviceToken
        ? { deviceToken }
        : this.opts.token || this.opts.password
          ? { token: this.opts.token, password: this.opts.password }
          : undefined;

    // The setup page has no device; everyone else signs when it can.
    let device:
      | { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string }
      | undefined;
    if (!this.opts.setupToken && this.opts.deviceIdentity) {
      const identity = await this.opts.deviceIdentity().catch(() => null);
      if (identity) {
        const signedAt = Date.now();
        const nonce = this.connectNonce ?? undefined;
        const payload = buildDeviceAuthPayload({
          deviceId: identity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs: signedAt,
          token: (auth as { token?: string } | undefined)?.token ?? null,
          nonce,
        });
        try {
          device = {
            id: identity.deviceId,
            publicKey: identity.publicKey,
            signature: await identity.sign(payload),
            signedAt,
            ...(nonce ? { nonce } : {}),
          };
        } catch (err) {
          console.warn("[gateway] device signing failed; connecting without a device", err);
        }
      }
    }
    // The socket may have closed while we awaited the key.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        ...(this.opts.displayName ? { displayName: this.opts.displayName } : {}),
        // Injected at build time from the root package.json (vite define, D-A),
        // same source as the Sidebar version label.
        version: this.opts.clientVersion ?? import.meta.env.VITE_APP_VERSION ?? "dev",
        platform: navigator.platform || "web",
        mode: clientMode,
      },
      role,
      scopes,
      caps: ["tool-events"],
      ...(device ? { device } : {}),
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    void this.request<GatewayHelloOk>("connect", params)
      .then((hello) => {
        this.backoffMs = 800;
        this.opts.onHello?.(hello);
      })
      .catch(() => {
        this.ws?.close(4008, "connect failed");
      });
  }

  /** Stop reconnecting after the gateway said this device is gone. */
  halt() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Reconnect now (the phone came back to the foreground), skipping the backoff wait. */
  reconnectNow() {
    if (this.closed || this.connected) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.backoffMs = 800;
    this.doConnect();
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      // Challenge arrives before the queued connect timer fires.
      // Store the nonce and send connect immediately (with guard).
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
        }
        void this.sendConnect();
        return;
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        const err = new GatewayRequestError({
          message: res.error?.message ?? "request failed",
          method: pending.method,
          code: res.error?.code ?? null,
          kind: "remote",
          details: res.error?.details,
        });
        this.opts.onRequestError?.(err);
        pending.reject(err);
      }
      return;
    }
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    // Delay connect to allow the challenge event to arrive first.
    // If the challenge arrives within 750ms, sendConnect() fires immediately
    // with the nonce (and the timer is cancelled by the guard).
    // If no challenge arrives, the timer fires sendConnect() without a nonce.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      void this.sendConnect();
    }, 750);
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      if (p.timer) {
        clearTimeout(p.timer);
      }
      // Promote plain Errors to structured disconnect errors so the
      // toast layer can distinguish "connection dropped mid-request"
      // from genuine remote failures.
      const structured =
        err instanceof GatewayRequestError
          ? err
          : new GatewayRequestError({
              message: err.message,
              method: p.method,
              kind: "disconnect",
            });
      this.opts.onRequestError?.(structured);
      p.reject(structured);
    }
    this.pending.clear();
  }
}
