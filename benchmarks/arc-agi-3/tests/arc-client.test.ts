import { describe, expect, it, vi } from "vitest";
import { ArcClient } from "../src/arc-client.js";
import {
  ArcApiError,
  ArcAuthError,
  BadGuidError,
  GameTerminalStateError,
  RateLimitError,
} from "../src/errors.js";
import { coordinateAction, simpleAction } from "../src/types.js";

const noSleep = async (_ms: number): Promise<void> => {};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("ArcClient", () => {
  it("rejects when no API key is configured", () => {
    const c = new ArcClient({ apiKey: "" });
    expect(c.hasApiKey()).toBe(false);
  });

  it("listGames returns array body directly", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { game_id: "ls20-abc", title: "Light Switch" },
        { game_id: "wm-def", title: "Whack Mole" },
      ]),
    );
    const client = new ArcClient({ apiKey: "k", fetchImpl, sleepImpl: noSleep });
    const games = await client.listGames();
    expect(games).toHaveLength(2);
    expect(games[0]!.game_id).toBe("ls20-abc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends X-API-Key + Content-Type on POSTs", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return jsonResponse({ card_id: "card-xyz" });
    });
    const client = new ArcClient({
      apiKey: "secret",
      baseUrl: "https://three.example.org",
      fetchImpl,
      sleepImpl: noSleep,
    });
    const cardId = await client.openScorecard({ tags: ["bench"] });
    expect(cardId).toBe("card-xyz");
    expect(captured).not.toBeNull();
    const headers = (captured!.init?.headers as Record<string, string>) ?? {};
    expect(headers["X-API-Key"]).toBe("secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(captured!.url).toBe("https://three.example.org/api/scorecard/open");
    expect(JSON.parse(captured!.init?.body as string)).toEqual({ tags: ["bench"] });
  });

  it("retries 429 with backoff then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), { status: 429 });
      }
      return jsonResponse({ card_id: "card-late" });
    });
    const sleeps: number[] = [];
    const sleepImpl = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const client = new ArcClient({ apiKey: "k", fetchImpl, sleepImpl, retryBaseMs: 100 });
    const cardId = await client.openScorecard();
    expect(cardId).toBe("card-late");
    expect(calls).toBe(3);
    // Backoff: 100ms (after attempt 0), 200ms (after attempt 1). Rate-gate
    // adds its own waits but those start at 0 because nextAvailable is 0.
    expect(sleeps.some((m) => m === 100)).toBe(true);
    expect(sleeps.some((m) => m === 200)).toBe(true);
  });

  it("throws RateLimitError when retries are exhausted", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), { status: 429 }),
    );
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
      maxRetries: 1,
      retryBaseMs: 1,
    });
    await expect(client.openScorecard()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("classifies 400 with guid message as BadGuidError (non-retryable)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "INVALID_GUID" }), { status: 400 });
    });
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
      maxRetries: 5,
      retryBaseMs: 1,
    });
    await expect(
      client.act({ gameId: "g", guid: "stale", action: simpleAction(1) }),
    ).rejects.toBeInstanceOf(BadGuidError);
    // Should NOT have retried — BadGuid is terminal.
    expect(calls).toBe(1);
  });

  it("classifies 400 with terminal-state body as GameTerminalStateError", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Game over, only RESET allowed" }), {
          status: 400,
        }),
    );
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
      maxRetries: 5,
      retryBaseMs: 1,
    });
    await expect(
      client.act({ gameId: "g", guid: "live", action: simpleAction(2) }),
    ).rejects.toBeInstanceOf(GameTerminalStateError);
  });

  it("classifies 401 as ArcAuthError", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const client = new ArcClient({
      apiKey: "bad",
      fetchImpl,
      sleepImpl: noSleep,
      maxRetries: 5,
      retryBaseMs: 1,
    });
    await expect(client.listGames()).rejects.toBeInstanceOf(ArcAuthError);
  });

  it("retries 503 (server error) and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 2) return new Response("upstream", { status: 503 });
      return jsonResponse([]);
    });
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
      retryBaseMs: 1,
    });
    const result = await client.listGames();
    expect(result).toEqual([]);
    expect(calls).toBe(2);
  });

  it("persists set-cookie per guid and replays on subsequent requests", async () => {
    let firstHadCookie = false;
    let secondHadCookie = false;
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (n === 1) {
        firstHadCookie = Boolean(headers.Cookie);
        return new Response(
          JSON.stringify({
            game_id: "g",
            guid: "S1",
            frame: [[[0]]],
            state: "NOT_FINISHED",
            levels_completed: 0,
            win_levels: 5,
            action_input: { id: 0, data: {} },
            available_actions: [1, 2, 3, 4],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "AWSALB=abc; Path=/; HttpOnly",
            },
          },
        );
      }
      secondHadCookie = Boolean(headers.Cookie);
      return jsonResponse({
        game_id: "g",
        guid: "S1",
        frame: [[[0]]],
        state: "NOT_FINISHED",
        levels_completed: 0,
        win_levels: 5,
        action_input: { id: 1, data: {} },
        available_actions: [1, 2, 3, 4],
      });
    });
    const client = new ArcClient({ apiKey: "k", fetchImpl, sleepImpl: noSleep });
    const first = await client.reset({ gameId: "g", cardId: "c", guid: "S1" });
    expect(first.guid).toBe("S1");
    await client.act({ gameId: "g", guid: "S1", action: simpleAction(1) });
    expect(firstHadCookie).toBe(false);
    expect(secondHadCookie).toBe(true);
  });

  it("rate-limits successive calls (ratePerSecond=2 → ~500ms gap)", async () => {
    const sleeps: number[] = [];
    const sleepImpl = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl,
      ratePerSecond: 2,
    });
    await client.listGames();
    await client.listGames();
    // First call has 0ms wait (slot==now). Second call waits up to ~500ms.
    const gateWaits = sleeps.filter((m) => m > 0 && m <= 600);
    expect(gateWaits.length).toBeGreaterThan(0);
  });

  it("ACTION6 requires (x,y) — coordinateAction validates range", () => {
    expect(() => coordinateAction(64, 0)).toThrow();
    expect(() => coordinateAction(0, -1)).toThrow();
    expect(coordinateAction(10, 20)).toEqual({ kind: "coordinate", x: 10, y: 20 });
  });

  it("simpleAction rejects ACTION6", () => {
    expect(() => simpleAction(6 as 5)).toThrow();
  });

  it("acts via coordinate path for ACTION6 with x,y body", async () => {
    let captured: { url: string; body?: unknown } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      return jsonResponse({
        game_id: "g",
        guid: "S1",
        frame: [[[0]]],
        state: "NOT_FINISHED",
        levels_completed: 0,
        win_levels: 1,
        action_input: { id: 6, data: { x: 5, y: 7 } },
        available_actions: [6],
      });
    });
    const client = new ArcClient({ apiKey: "k", fetchImpl, sleepImpl: noSleep });
    await client.act({
      gameId: "g",
      guid: "S1",
      action: coordinateAction(5, 7, { strategy: "explore" }),
    });
    expect(captured!.url).toContain("/api/cmd/ACTION6");
    expect(captured!.body).toMatchObject({
      game_id: "g",
      guid: "S1",
      x: 5,
      y: 7,
      reasoning: { strategy: "explore" },
    });
  });

  it("bubbles non-retryable ArcApiError without retrying", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response("not found", { status: 404 });
    });
    const client = new ArcClient({
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
      maxRetries: 5,
      retryBaseMs: 1,
    });
    await expect(client.listGames()).rejects.toBeInstanceOf(ArcApiError);
    expect(calls).toBe(1);
  });
});
