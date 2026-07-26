import { readStaleBootVerify } from "../infra/boot-verify.js";
import { note } from "../terminal/note.js";
import { isDoctorJsonMode } from "./doctor-check.js";
import { recordDoctorLevel, recordFinding } from "./doctor-outcome.js";

/**
 * Surface a post-update boot that never confirmed healthy. The beacon is armed
 * by update.run and cleared by the gateway the moment it is listening, so this
 * only fires when a fresh boot silently failed — turning a mysteriously-down
 * node into a loud, actionable error with the exact rollback sha. Error-level,
 * so it also fails a subsequent update gate until the human resolves it.
 */
export function noteBootHealth(now: number = Date.now()): void {
  const stale = readStaleBootVerify(now);
  if (!stale) return;

  const armedAgo = Math.round((now - stale.armedAt) / 60_000);
  const lines = [
    "The last update restarted the gateway, but the new build never confirmed a healthy boot",
    `(armed ~${armedAgo} min ago and still unacknowledged). The node may be running the old`,
    "process, degraded, or down.",
  ];
  if (stale.prevSha) {
    lines.push(
      "",
      "If the node is broken, roll back to the previous known-good commit:",
      `  git reset --hard ${stale.prevSha} && pnpm build && pnpm start gateway`,
    );
  }
  lines.push("", "If the gateway is actually running fine, start it once to clear this beacon.");

  const message = lines.join("\n");
  recordDoctorLevel("error", "post-update boot never confirmed healthy");
  recordFinding("Update Health", "error", message);
  if (isDoctorJsonMode()) return;
  note(`✘ ${message}`, "Update Health");
}
