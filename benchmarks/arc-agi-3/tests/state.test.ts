import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FrameResponse } from "../src/types.js";
import {
  appendScorecard,
  cacheGames,
  getCurrentSession,
  persistFrameResponse,
  pixelChanges,
  readCachedGames,
  readConfig,
  readGameMeta,
  readScorecards,
  upsertSession,
  updateScorecardClose,
  writeConfig,
} from "../src/state.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arc-state-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("state config + games + sessions", () => {
  it("readConfig returns defaults on first read", () => {
    const cfg = readConfig(tmpRoot);
    expect(cfg.apiBaseUrl).toBe("https://three.arcprize.org");
    expect(fs.existsSync(path.join(tmpRoot, "config.json"))).toBe(true);
  });

  it("writeConfig persists updates", () => {
    writeConfig({ apiBaseUrl: "https://three.arcprize.org", currentCardId: "card-abc" }, tmpRoot);
    expect(readConfig(tmpRoot).currentCardId).toBe("card-abc");
  });

  it("cacheGames + readCachedGames roundtrip", () => {
    cacheGames(
      [
        { game_id: "ls20-x", title: "Light Switch" },
        { game_id: "wm-y", title: "Whack Mole" },
      ],
      tmpRoot,
    );
    const cached = readCachedGames(tmpRoot);
    expect(cached.games).toHaveLength(2);
    expect(cached.fetched_at).toMatch(/T/);
  });

  it("upsertSession + getCurrentSession", () => {
    upsertSession(
      {
        game_id: "ls20-x",
        guid: "guid-1",
        started_at: new Date().toISOString(),
        card_id: "card-1",
        last_state: "NOT_FINISHED",
        levels_completed: 0,
        actions_submitted: 3,
      },
      tmpRoot,
    );
    const got = getCurrentSession("ls20-x", tmpRoot);
    expect(got?.guid).toBe("guid-1");
    expect(got?.actions_submitted).toBe(3);
  });
});

describe("scorecard journal", () => {
  it("appendScorecard + updateScorecardClose", () => {
    appendScorecard(
      {
        card_id: "card-1",
        opened_at: "2026-05-18T00:00:00Z",
        tags: ["bench"],
      },
      tmpRoot,
    );
    updateScorecardClose(
      "card-1",
      "2026-05-18T12:00:00Z",
      "https://arcprize.org/scorecard/card-1",
      tmpRoot,
    );
    const cards = readScorecards(tmpRoot);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.closed_at).toBe("2026-05-18T12:00:00Z");
    expect(cards[0]!.scorecard_url).toContain("card-1");
  });
});

describe("frames + pixelChanges", () => {
  const mkFrame = (last: number[][]): FrameResponse["frame"] => [last];
  it("pixelChanges counts differing cells", () => {
    expect(
      pixelChanges(
        mkFrame([
          [0, 0],
          [0, 0],
        ]),
        mkFrame([
          [0, 1],
          [2, 0],
        ]),
      ),
    ).toBe(2);
  });

  it("pixelChanges returns -1 on shape mismatch", () => {
    expect(pixelChanges(mkFrame([[0]]), mkFrame([[0, 0]]))).toBe(-1);
    expect(pixelChanges(undefined, mkFrame([[0]]))).toBe(-1);
  });

  it("persistFrameResponse writes file + bumps frame_count", () => {
    const response: FrameResponse = {
      game_id: "ls20-x",
      guid: "guid-9",
      frame: mkFrame([
        [0, 0],
        [0, 0],
      ]),
      state: "NOT_FINISHED",
      levels_completed: 1,
      win_levels: 6,
      action_input: { id: 1, data: {} },
      available_actions: [1, 2, 3, 4, 5],
    };
    const { index, meta } = persistFrameResponse({
      gameId: "ls20-x",
      response,
      root: tmpRoot,
    });
    expect(index).toBe(0);
    expect(meta.frame_count).toBe(1);
    expect(meta.levels_completed).toBe(1);
    expect(fs.existsSync(path.join(tmpRoot, "games", "ls20-x", "frames", "frame_0000.json"))).toBe(
      true,
    );

    const next = persistFrameResponse({
      gameId: "ls20-x",
      response: { ...response, action_input: { id: 2, data: {} } },
      prevFrame: mkFrame([
        [0, 0],
        [0, 0],
      ]),
      root: tmpRoot,
    });
    expect(next.index).toBe(1);
    expect(readGameMeta("ls20-x", tmpRoot).frame_count).toBe(2);
  });
});
