/**
 * The `monitor` tool: the agent sets up a watch on a page or an API and is
 * woken only when it changes (PLAN-53 E5, E6). Checking is a plain fetch on
 * the gateway with no model call.
 */

import { Type } from "@sinclair/typebox";
import { getMonitorEngine } from "../../monitors/runtime.js";
import { currentRunIsNonOwner } from "../run-owner-context.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const MONITOR_ACTIONS = ["list", "add", "update", "remove", "check"] as const;

const MonitorToolSchema = Type.Object({
  action: stringEnum(MONITOR_ACTIONS, {
    description:
      "list | add (needs monitor) | update (needs id + patch) | remove | check (run one now)",
  }),
  id: Type.Optional(Type.String({ description: "Monitor id, for update, remove and check." })),
  monitor: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "For add. Fields: name; url (public http/https); " +
          'extract = {kind:"text"} for the page\'s visible text (default), {kind:"json", path:"data.price"} for a field of a JSON API, or {kind:"regex", pattern:"...", group:1}; ' +
          'condition = {kind:"changed"} (default), {kind:"contains", text:"In stock"}, {kind:"not-contains", text:"Sold out"}, {kind:"above", value:100} or {kind:"below", value:100}; ' +
          "intervalMinutes (default 15, minimum 1); note = what to do when it fires, in the user's words.",
      },
    ),
  ),
  patch: Type.Optional(
    Type.Object(
      {},
      { additionalProperties: true, description: "For update: the monitor fields to change." },
    ),
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createMonitorTool(): AnyAgentTool {
  return {
    label: "Monitor",
    name: "monitor",
    description: [
      "Watch a web page or an API and get woken only when it changes: a price, a stock status, a status page, a new release.",
      "Prefer this to a recurring cron job that re-reads the page: a monitor costs nothing until something happens.",
      "Narrow what is watched with `extract` so unrelated page changes (ads, timestamps) do not fire it.",
      "After `add`, run `check` once to confirm the value it reads is the one you meant.",
    ].join(" "),
    parameters: MonitorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const engine = getMonitorEngine();
      if (!engine) {
        throw new Error("Monitors are not available: they are turned off on this gateway.");
      }
      if (action === "list") {
        return jsonResult({ monitors: engine.list() });
      }
      // A watch makes this gateway fetch a URL for as long as it exists; only
      // the owner sets those up or changes them.
      if (currentRunIsNonOwner()) {
        throw new Error("Only the owner can add, change, remove or run monitors.");
      }
      switch (action) {
        case "add": {
          if (!isRecord(params.monitor)) {
            throw new Error("add needs `monitor`, e.g. {name, url, condition}.");
          }
          return jsonResult({ ok: true, monitor: await engine.add(params.monitor) });
        }
        case "update": {
          const id = readStringParam(params, "id", { required: true });
          if (!isRecord(params.patch)) {
            throw new Error("update needs `patch` with the fields to change.");
          }
          return jsonResult({ ok: true, monitor: await engine.update(id, params.patch) });
        }
        case "remove": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult({ ok: await engine.remove(id) });
        }
        case "check": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult({ monitor: await engine.check(id) });
        }
        default:
          throw new Error(
            `Unknown monitor action: ${action}. Use one of ${MONITOR_ACTIONS.join(", ")}.`,
          );
      }
    },
  };
}
