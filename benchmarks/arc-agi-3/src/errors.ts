/**
 * Error hierarchy for the ARC-AGI-3 client. All errors carry the HTTP
 * status and a parsed body when available so callers can distinguish
 * recoverable conditions (429 rate limit, 5xx) from terminal ones
 * (400 bad request, 401/403 auth).
 */

export class ArcApiError extends Error {
  readonly status: number;
  readonly bodyText?: string;
  readonly bodyJson?: unknown;
  readonly url?: string;

  constructor(opts: {
    message: string;
    status: number;
    bodyText?: string;
    bodyJson?: unknown;
    url?: string;
  }) {
    super(opts.message);
    this.name = "ArcApiError";
    this.status = opts.status;
    this.bodyText = opts.bodyText;
    this.bodyJson = opts.bodyJson;
    this.url = opts.url;
  }
}

/** Raised on HTTP 429 from the server (600 RPM rate limit). Retryable. */
export class RateLimitError extends ArcApiError {
  constructor(opts: { bodyText?: string; bodyJson?: unknown; url?: string }) {
    super({
      message: "ARC-AGI-3 rate limit exceeded (600 RPM)",
      status: 429,
      bodyText: opts.bodyText,
      bodyJson: opts.bodyJson,
      url: opts.url,
    });
    this.name = "RateLimitError";
  }
}

/**
 * Raised when the server reports the session guid is stale (typically
 * `400` with a "guid" / "session" hint in the body). Caller should
 * drop the cookie jar and re-RESET the game.
 */
export class BadGuidError extends ArcApiError {
  constructor(opts: { bodyText?: string; bodyJson?: unknown; url?: string }) {
    super({
      message: "ARC-AGI-3 session guid is stale or unknown",
      status: 400,
      bodyText: opts.bodyText,
      bodyJson: opts.bodyJson,
      url: opts.url,
    });
    this.name = "BadGuidError";
  }
}

/**
 * Raised when the agent submits any non-RESET action to a session that
 * has reached `state=GAME_OVER` or `state=WIN`. Server returns 400.
 * Caller should call RESET (level reset or --full).
 */
export class GameTerminalStateError extends ArcApiError {
  constructor(opts: { bodyText?: string; bodyJson?: unknown; url?: string }) {
    super({
      message: "Game has terminal state; only RESET is accepted",
      status: 400,
      bodyText: opts.bodyText,
      bodyJson: opts.bodyJson,
      url: opts.url,
    });
    this.name = "GameTerminalStateError";
  }
}

/**
 * Raised when no `X-API-Key` header is configured or the server
 * rejects it. Not retryable; configure ARC_API_KEY and try again.
 */
export class ArcAuthError extends ArcApiError {
  constructor(opts: { status: number; bodyText?: string; bodyJson?: unknown; url?: string }) {
    super({
      message: `ARC-AGI-3 auth failed (HTTP ${opts.status}); check ARC_API_KEY`,
      status: opts.status,
      bodyText: opts.bodyText,
      bodyJson: opts.bodyJson,
      url: opts.url,
    });
    this.name = "ArcAuthError";
  }
}

/**
 * Helper: classify a non-OK fetch response into the right error type.
 * The body has already been read into `bodyText`/`bodyJson` by the
 * caller. Looks at status + body content to pick the most specific
 * error subclass.
 */
export function classifyArcError(args: {
  status: number;
  bodyText?: string;
  bodyJson?: unknown;
  url?: string;
}): ArcApiError {
  if (args.status === 429) {
    return new RateLimitError(args);
  }
  if (args.status === 401 || args.status === 403) {
    return new ArcAuthError(args);
  }
  if (args.status === 400) {
    const text = (args.bodyText ?? "").toLowerCase();
    const errCode =
      typeof args.bodyJson === "object" && args.bodyJson !== null
        ? String((args.bodyJson as Record<string, unknown>).error ?? "")
        : "";
    if (text.includes("guid") || errCode.includes("GUID") || errCode.includes("SESSION")) {
      return new BadGuidError(args);
    }
    if (text.includes("game over") || text.includes("terminal") || text.includes("only reset")) {
      return new GameTerminalStateError(args);
    }
  }
  return new ArcApiError({
    message: `ARC-AGI-3 request failed: HTTP ${args.status}`,
    status: args.status,
    bodyText: args.bodyText,
    bodyJson: args.bodyJson,
    url: args.url,
  });
}
