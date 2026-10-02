/**
 * CDP screencast of one page, over the Playwright connection the browser tool
 * already holds (PLAN-53 A2).
 *
 * It goes through Playwright's CDPSession rather than a second raw socket, so
 * it uses whatever connection the agent's browser tool already has. Verified
 * against a directly launched Chromium (the managed profile). The Chrome
 * extension relay can refuse CDP session attachment (see pw-session.ts); there
 * the caller gets the error and reports the view as unavailable.
 *
 * It only watches. `Page.startScreencast` does not move focus, navigate, or
 * take the page from the agent.
 */

import type { CDPSession, Page } from "playwright-core";
import type { CdpInputCommand } from "./live-input.js";
import { getPageForTargetId } from "./pw-session.js";

export type ScreencastFrame = {
  /** Base64 JPEG. */
  data: string;
  /** Viewport size in CSS pixels; the JPEG may be scaled down from this. */
  deviceWidth: number;
  deviceHeight: number;
};

export type ScreencastHandle = {
  stop: () => Promise<void>;
  /** Current URL and title of the page being watched. */
  describe: () => Promise<{ url: string; title: string }>;
  /** Deliver one validated pointer or key event to the page. */
  input: (command: CdpInputCommand) => Promise<void>;
};

export type ScreencastOptions = {
  cdpUrl: string;
  targetId?: string;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  onFrame: (frame: ScreencastFrame) => void;
  /** The page closed or the session dropped; the handle is dead. */
  onClosed: (reason: string) => void;
};

type ScreencastFrameEvent = {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
};

export async function startScreencastViaPlaywright(
  opts: ScreencastOptions,
): Promise<ScreencastHandle> {
  const page: Page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const session: CDPSession = await page.context().newCDPSession(page);
  let stopped = false;

  const closed = (reason: string) => {
    if (stopped) {
      return;
    }
    stopped = true;
    opts.onClosed(reason);
  };

  const onFrame = (event: ScreencastFrameEvent) => {
    // Chrome sends the next frame only after the previous one is acknowledged,
    // so ack first: a slow consumer must not stall the stream.
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    if (stopped) {
      return;
    }
    opts.onFrame({
      data: event.data,
      deviceWidth: event.metadata?.deviceWidth ?? 0,
      deviceHeight: event.metadata?.deviceHeight ?? 0,
    });
  };
  const onPageClose = () => closed("page closed");

  session.on("Page.screencastFrame", onFrame);
  page.once("close", onPageClose);

  try {
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: opts.quality,
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
      everyNthFrame: 1,
    });
  } catch (err) {
    stopped = true;
    page.off("close", onPageClose);
    await session.detach().catch(() => {});
    throw err;
  }

  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      session.off("Page.screencastFrame", onFrame);
      page.off("close", onPageClose);
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    },
    describe: async () => ({
      url: page.url(),
      title: await page.title().catch(() => ""),
    }),
    input: async (command) => {
      if (stopped) {
        return;
      }
      await session.send(command.method, command.params as never);
    },
  };
}
