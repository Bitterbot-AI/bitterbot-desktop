import { Type } from "@sinclair/typebox";
import { getActiveOrchestratorBridge } from "../../infra/orchestrator-bridge.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

/**
 * PLAN-14 Pillar 4: unified computer_use tool.
 *
 * Routes OS-level actions (screenshot, mouse, keyboard) through the
 * orchestrator daemon's IPC. The orchestrator must be built with
 * `--features=computer-use` and the operator must set
 * BITTERBOT_COMPUTER_USE=1 — both gates apply, by design, so a
 * misconfigured node can never silently start clicking.
 *
 * Browser routing is intentionally not handled here: agents wanting
 * web automation use the `browser` tool, which talks to the existing
 * pw-tools-core stack. This tool is the OS counterpart.
 */

const COMPUTER_ACTIONS = [
  "screenshot",
  "screen_size",
  "mouse_move",
  "mouse_click",
  "type",
  "key",
] as const;

const ComputerUseSchema = Type.Object({
  action: stringEnum(COMPUTER_ACTIONS),
  // screenshot / screen_size
  monitorIndex: Type.Optional(Type.Number()),
  // mouse_move
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  // mouse_click
  button: Type.Optional(Type.String()),
  // type
  text: Type.Optional(Type.String()),
  // key
  key: Type.Optional(Type.String()),
});

const NO_BRIDGE_ERROR =
  "computer_use unavailable: orchestrator daemon not connected. " +
  "Enable p2p in config and ensure the orchestrator was built with --features=computer-use.";

export function createComputerUseTool(): AnyAgentTool {
  return {
    label: "Computer use",
    name: "computer_use",
    description:
      "Control the host computer at the OS level (screenshot, mouse, keyboard) via the orchestrator daemon. " +
      "Requires BITTERBOT_COMPUTER_USE=1 and an orchestrator built with --features=computer-use.",
    parameters: ComputerUseSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | (typeof COMPUTER_ACTIONS)[number]
        | undefined;
      if (!action) {
        return jsonResult({ ok: false, error: "missing action" });
      }
      const bridge = getActiveOrchestratorBridge();
      if (!bridge) {
        return jsonResult({ ok: false, error: NO_BRIDGE_ERROR });
      }

      try {
        switch (action) {
          case "screenshot": {
            const monitorIndex = numberOrUndefined(params.monitorIndex);
            const result = await bridge.computerScreenshot(monitorIndex);
            return jsonResult(result);
          }
          case "screen_size": {
            const monitorIndex = numberOrUndefined(params.monitorIndex);
            const result = await bridge.computerScreenSize(monitorIndex);
            return jsonResult(result);
          }
          case "mouse_move": {
            const x = numberOrUndefined(params.x);
            const y = numberOrUndefined(params.y);
            if (x === undefined || y === undefined) {
              return jsonResult({ ok: false, error: "mouse_move requires x and y" });
            }
            const result = await bridge.computerMouseMove(x, y);
            return jsonResult(result);
          }
          case "mouse_click": {
            const buttonRaw = readStringParam(params, "button", { required: false });
            const button =
              (["left", "right", "middle"] as const).find((b) => b === buttonRaw) ?? "left";
            const result = await bridge.computerMouseClick(button);
            return jsonResult(result);
          }
          case "type": {
            const text = readStringParam(params, "text", { required: true });
            if (text === undefined) {
              return jsonResult({ ok: false, error: "type requires text" });
            }
            const result = await bridge.computerType(text);
            return jsonResult(result);
          }
          case "key": {
            const key = readStringParam(params, "key", { required: true });
            if (!key) {
              return jsonResult({ ok: false, error: "key requires the key name" });
            }
            const result = await bridge.computerKey(key);
            return jsonResult(result);
          }
          default: {
            const _exhaustive: never = action;
            return jsonResult({ ok: false, error: `unknown action: ${String(_exhaustive)}` });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: `computer_use failed: ${message}` });
      }
    },
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}
