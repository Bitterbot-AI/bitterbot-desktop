/**
 * ARC-AGI-3 REST client.
 *
 * Single-class typed client over `https://three.arcprize.org` with:
 *   - `X-API-Key` auth from `ARC_API_KEY` env (overridable per-instance).
 *   - Per-`guid` cookie jar so AWSALB sticky routing survives across calls.
 *   - Internal rate limiter (default 9 RPS, well under the 600 RPM cap).
 *   - Retry with exponential backoff on 429 and 5xx; classified errors
 *     (BadGuidError, GameTerminalStateError) skip retry.
 *   - Injectable `fetchImpl` for tests.
 *
 * All response bodies are typed against `types.ts`. Errors thrown are
 * subclasses of `ArcApiError` so callers can switch on `.name` or use
 * `instanceof`.
 */

import {
  ArcApiError,
  BadGuidError,
  classifyArcError,
  GameTerminalStateError,
  RateLimitError,
} from "./errors.js";
import {
  type ArcAction,
  type CloseScorecardBody,
  type CoordinateActionBody,
  type FrameResponse,
  type GameSummary,
  type OpenScorecardBody,
  type OpenScorecardResponse,
  type ResetCommandBody,
  type ScorecardSummary,
  type SimpleActionBody,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://three.arcprize.org";
const DEFAULT_RATE_PER_SECOND = 9;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1000;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface ArcClientConfig {
  /** Required at request time; resolved from `ARC_API_KEY` env if omitted. */
  apiKey?: string;
  /** Override base URL (e.g. for tests). */
  baseUrl?: string;
  /** Inject a fetch implementation; defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Internal rate limit in requests/second. Default 9 (~540 RPM). */
  ratePerSecond?: number;
  /** Max retries on 429 / 5xx. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Default 1000. */
  retryBaseMs?: number;
  /**
   * Optional sleep impl so tests can fast-forward retry delays
   * without real `setTimeout`. Defaults to a real sleep.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-`guid` cookie storage. AWSALB sticky-routing cookies are
 * partitioned by session because each game session can be on a
 * different ALB target group.
 */
class CookieJar {
  private byGuid = new Map<string, string[]>();

  setFromResponse(guid: string, response: Response): void {
    const setCookies = (response as Response & { headers: Headers }).headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      // Fallback for runtimes that don't expose getSetCookie.
      const raw = response.headers.get("set-cookie");
      if (raw) {
        setCookies.push(raw);
      }
    }
    if (setCookies.length === 0) {
      return;
    }
    const existing = this.byGuid.get(guid) ?? [];
    const merged = mergeCookies(existing, setCookies);
    this.byGuid.set(guid, merged);
  }

  cookieHeader(guid: string | undefined | null): string | undefined {
    if (!guid) {
      return undefined;
    }
    const cookies = this.byGuid.get(guid);
    if (!cookies || cookies.length === 0) {
      return undefined;
    }
    return cookies
      .map((c) => c.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
  }

  clear(guid: string): void {
    this.byGuid.delete(guid);
  }
}

function mergeCookies(existing: string[], incoming: string[]): string[] {
  const byName = new Map<string, string>();
  for (const c of existing) {
    const name = c.split("=")[0]?.trim() ?? "";
    if (name) {
      byName.set(name, c);
    }
  }
  for (const c of incoming) {
    const name = c.split("=")[0]?.trim() ?? "";
    if (name) {
      byName.set(name, c);
    }
  }
  return Array.from(byName.values());
}

/**
 * Token-bucket-ish rate limiter: hold each request until the previous
 * one was ≥ (1000/rate) ms ago. Simple and good enough for a single
 * agent talking to one upstream.
 */
class TimeGate {
  private nextAvailable = 0;
  constructor(
    private readonly ratePerSecond: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const minGap = 1000 / Math.max(1, this.ratePerSecond);
    const slot = Math.max(this.nextAvailable, now);
    const waitMs = slot - now;
    this.nextAvailable = slot + minGap;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }
}

export class ArcClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: TimeGate;
  private readonly jar = new CookieJar();

  constructor(cfg: ArcClientConfig = {}) {
    const key = cfg.apiKey ?? process.env.ARC_API_KEY ?? "";
    this.apiKey = key.trim();
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? ((...a) => fetch(...(a as Parameters<typeof fetch>)));
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = cfg.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.sleep = cfg.sleepImpl ?? realSleep;
    this.gate = new TimeGate(cfg.ratePerSecond ?? DEFAULT_RATE_PER_SECOND, this.sleep);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async listGames(): Promise<GameSummary[]> {
    const data = await this.request<GameSummary[] | { games: GameSummary[] }>({
      method: "GET",
      path: "/api/games",
    });
    if (Array.isArray(data)) {
      return data;
    }
    return data.games;
  }

  async openScorecard(body: OpenScorecardBody = {}): Promise<string> {
    const data = await this.request<OpenScorecardResponse>({
      method: "POST",
      path: "/api/scorecard/open",
      body,
    });
    return data.card_id;
  }

  async closeScorecard(cardId: string): Promise<ScorecardSummary> {
    const body: CloseScorecardBody = { card_id: cardId };
    return await this.request<ScorecardSummary>({
      method: "POST",
      path: "/api/scorecard/close",
      body,
    });
  }

  async getScorecard(cardId: string, gameId?: string): Promise<ScorecardSummary> {
    const path = gameId
      ? `/api/scorecard/${encodeURIComponent(cardId)}/${encodeURIComponent(gameId)}`
      : `/api/scorecard/${encodeURIComponent(cardId)}`;
    return await this.request<ScorecardSummary>({ method: "GET", path });
  }

  /**
   * Issue a `RESET`. Pass an existing `guid` to reset that session
   * (level reset). Pass `null`/`undefined` to start a fresh session.
   */
  async reset(opts: {
    gameId: string;
    cardId: string;
    guid?: string | null;
  }): Promise<FrameResponse> {
    const body: ResetCommandBody = {
      game_id: opts.gameId,
      card_id: opts.cardId,
      guid: opts.guid ?? null,
    };
    return await this.request<FrameResponse>({
      method: "POST",
      path: "/api/cmd/RESET",
      body,
      guid: opts.guid ?? undefined,
    });
  }

  /**
   * Submit one action. `action.kind === "reset"` is handled here too
   * by dispatching to `/api/cmd/RESET` with an existing guid (level
   * reset shortcut from inside a play loop).
   */
  async act(opts: { gameId: string; guid: string; action: ArcAction }): Promise<FrameResponse> {
    const { gameId, guid, action } = opts;
    if (action.kind === "reset") {
      return this.reset({ gameId, cardId: "", guid });
    }
    if (action.kind === "simple") {
      const body: SimpleActionBody = { game_id: gameId, guid };
      if (action.reasoning) body.reasoning = action.reasoning;
      return await this.request<FrameResponse>({
        method: "POST",
        path: `/api/cmd/ACTION${action.action}`,
        body,
        guid,
      });
    }
    // coordinate action (ACTION6)
    const body: CoordinateActionBody = {
      game_id: gameId,
      guid,
      x: action.x,
      y: action.y,
    };
    if (action.reasoning) body.reasoning = action.reasoning;
    return await this.request<FrameResponse>({
      method: "POST",
      path: `/api/cmd/ACTION6`,
      body,
      guid,
    });
  }

  // ─── Internal: request lifecycle ────────────────────────────────

  private async request<T>(opts: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    guid?: string;
  }): Promise<T> {
    if (!this.apiKey) {
      throw new ArcApiError({
        message: "ARC_API_KEY not configured",
        status: 0,
      });
    }
    const url = `${this.baseUrl}${opts.path}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.gate.wait();
      try {
        const response = await this.sendOnce({
          url,
          method: opts.method,
          body: opts.body,
          guid: opts.guid,
        });
        if (response.ok) {
          if (opts.guid) {
            this.jar.setFromResponse(opts.guid, response);
          }
          return (await response.json()) as T;
        }
        // Body may be empty; tolerate.
        const bodyText = await response.text().catch(() => undefined);
        const bodyJson = parseSafe(bodyText);
        const err = classifyArcError({
          status: response.status,
          bodyText,
          bodyJson,
          url,
        });
        if (err instanceof BadGuidError && opts.guid) {
          this.jar.clear(opts.guid);
        }
        if (!isRetryable(err) || attempt === this.maxRetries) {
          throw err;
        }
        lastErr = err;
      } catch (caught) {
        if (caught instanceof ArcApiError) {
          if (!isRetryable(caught) || attempt === this.maxRetries) {
            throw caught;
          }
          lastErr = caught;
        } else {
          // Network-level failure (TypeError, DNS, etc.)
          if (attempt === this.maxRetries) {
            throw caught;
          }
          lastErr = caught;
        }
      }
      const wait = this.retryDelayMs(attempt);
      await this.sleep(wait);
    }
    throw lastErr ?? new ArcApiError({ message: "Retries exhausted", status: 0 });
  }

  private async sendOnce(opts: {
    url: string;
    method: "GET" | "POST";
    body?: unknown;
    guid?: string;
  }): Promise<Response> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };
    const cookieHeader = this.jar.cookieHeader(opts.guid);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }
    return await this.fetchImpl(opts.url, {
      method: opts.method,
      headers,
      body: bodyStr,
    });
  }

  private retryDelayMs(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt;
  }
}

function isRetryable(err: ArcApiError): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof BadGuidError) return false;
  if (err instanceof GameTerminalStateError) return false;
  if (err.status >= 500 && err.status < 600) return true;
  return false;
}

function parseSafe(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
