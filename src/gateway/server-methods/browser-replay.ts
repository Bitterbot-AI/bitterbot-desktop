/**
 * Session replay RPC (PLAN-53 A6): list recorded browser sessions, read their
 * frame index and frames, delete a recording. Frames show whatever the
 * agent's browser showed, so these sit in the same scope as the live view.
 */

import {
  deleteReplaySession,
  listReplayFrames,
  listReplaySessions,
  readReplayFrame,
  replaySessionId,
} from "../../browser/replay.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A recording is named by its folder id, or by the session key it belongs to. */
const resolveId = (params: Record<string, unknown>) =>
  str(params.id) || (str(params.sessionKey) ? replaySessionId(str(params.sessionKey)) : "");

export const browserReplayHandlers: GatewayRequestHandlers = {
  "browser.replay.list": ({ respond }) => {
    respond(true, { sessions: listReplaySessions() });
  },

  "browser.replay.frames": ({ params, respond }) => {
    const id = resolveId(params);
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "id or sessionKey required"),
      );
      return;
    }
    respond(true, {
      id,
      frames: listReplayFrames(id, { from: num(params.from), to: num(params.to) }),
    });
  },

  "browser.replay.frame": ({ params, respond }) => {
    const id = resolveId(params);
    const data = readReplayFrame(id, str(params.file));
    if (!data) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no such frame"));
      return;
    }
    respond(true, { mimeType: "image/jpeg", data: data.toString("base64") });
  },

  "browser.replay.delete": ({ params, respond }) => {
    respond(true, { ok: deleteReplaySession(resolveId(params)) });
  },
};
