import { readRollbackRecord, readStaleBootVerify } from "../infra/boot-verify.js";
import { error, renderSection, warn } from "./doctor-check.js";

/**
 * Surface a post-update boot that never confirmed healthy, and any automatic
 * rollback the boot watchdog performed. The beacon is armed by both update
 * paths and cleared by the gateway the moment it is listening, so the stale
 * case only fires when a fresh boot silently failed — error-level, so it
 * also fails a subsequent update gate until the human resolves it.
 *
 * A PERFORMED rollback is warn-level: the node is healthy again on the old
 * code (degraded-but-usable per the severity contract), but the human must
 * know the last update was bad — the warning persists until the next clean
 * update clears the record.
 */
export function noteBootHealth(now: number = Date.now()): void {
  const results = [];

  const rollback = readRollbackRecord();
  if (rollback) {
    const agoMin = Math.round((now - rollback.at) / 60_000);
    results.push(
      rollback.ok
        ? warn(
            [
              `The boot watchdog ROLLED BACK this node ~${agoMin} min ago: the updated build`,
              `(${rollback.fromSha?.slice(0, 12) ?? "unknown"}) never confirmed a healthy boot, so it was reset to`,
              `${rollback.toSha.slice(0, 12)} and rebuilt (${rollback.detail}).`,
              "The node is running PRE-UPDATE code. Investigate the bad build before updating again;",
              "the next clean update clears this notice.",
            ].join("\n"),
          )
        : error(
            [
              `The boot watchdog attempted a rollback ~${agoMin} min ago and FAILED:`,
              rollback.detail,
              "",
              "Manual recovery:",
              `  git reset --hard ${rollback.toSha} && pnpm install && pnpm build && pnpm start gateway`,
              "",
              "A healthy gateway boot clears this error automatically",
              "(state file: <stateDir>/rollback-performed.json; watchdog log: <stateDir>/boot-watchdog.log).",
            ].join("\n"),
          ),
    );
  }

  const stale = readStaleBootVerify(now);
  if (stale) {
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
    results.push(error(lines.join("\n")));
  }

  if (results.length > 0) {
    renderSection("Update Health", results);
  }
}
