/**
 * monitors.*: watches on a page or API (PLAN-53 E5). `list` needs read;
 * everything that changes or runs one needs write, like the cron methods.
 */

import { getMonitorEngine } from "../../monitors/runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function engineOrThrow() {
  const engine = getMonitorEngine();
  if (!engine) {
    throw new Error("monitors are not running on this gateway");
  }
  return engine;
}

const readId = (params: Record<string, unknown>): string => {
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) {
    throw new Error("id is required");
  }
  return id;
};

const fail = (err: unknown) =>
  errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));

export const monitorHandlers: GatewayRequestHandlers = {
  "monitors.list": ({ respond }) => {
    try {
      respond(true, { monitors: engineOrThrow().list() });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "monitors.add": async ({ params, respond }) => {
    try {
      respond(true, await engineOrThrow().add(params));
    } catch (err) {
      respond(false, undefined, fail(err));
    }
  },
  "monitors.update": async ({ params, respond }) => {
    try {
      const patch = isRecord(params.patch) ? params.patch : {};
      respond(true, await engineOrThrow().update(readId(params), patch));
    } catch (err) {
      respond(false, undefined, fail(err));
    }
  },
  "monitors.remove": async ({ params, respond }) => {
    try {
      respond(true, { ok: await engineOrThrow().remove(readId(params)) });
    } catch (err) {
      respond(false, undefined, fail(err));
    }
  },
  "monitors.check": async ({ params, respond }) => {
    try {
      respond(true, await engineOrThrow().check(readId(params)));
    } catch (err) {
      respond(false, undefined, fail(err));
    }
  },
};
