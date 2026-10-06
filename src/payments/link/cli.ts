/**
 * Talking to Stripe's Link CLI (PLAN-53 C1).
 *
 * Link Agent Wallet gives an agent a one-time card from the owner's own Link
 * account, for one purchase the owner approves in the Link app. Stripe's SDK
 * does not log in; its CLI does (a verification phrase the owner approves),
 * keeps the token, and can write a card to a 0600 file instead of printing
 * it. So the rail drives the CLI, with its credentials in a file under the
 * Bitterbot state directory, and asks for JSON output.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";

/** Pinned: a money path does not float to whatever version is newest. */
export const LINK_CLI_PACKAGE = "@stripe/link-cli@0.26.0";

export type LinkCliRunner = (args: string[]) => Promise<unknown>;

export type LinkSettings = {
  enabled: boolean;
  command: string[];
  authFile: string;
  cardDir: string;
  perPurchaseCapUsd: number;
};

export function resolveLinkSettings(cfg: BitterbotConfig): LinkSettings {
  const link = cfg.payments?.link ?? {};
  const base = path.join(os.homedir(), ".bitterbot", "link");
  return {
    enabled: link.enabled === true,
    command:
      Array.isArray(link.command) && link.command.length > 0
        ? link.command
        : ["npx", "-y", LINK_CLI_PACKAGE],
    authFile: link.authFile ?? path.join(base, "auth.json"),
    cardDir: path.join(base, "cards"),
    perPurchaseCapUsd: link.perPurchaseCapUsd ?? 100,
  };
}

/** Run the CLI with JSON output and parse it. Throws with the CLI's own message. */
export function createLinkCliRunner(settings: LinkSettings): LinkCliRunner {
  const [bin, ...prefix] = settings.command;
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        [...prefix, ...args, "--auth", settings.authFile, "--format", "json"],
        {
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
        },
        (err, stdout, stderr) => {
          const text = stdout.trim();
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = undefined;
          }
          if (err) {
            const detail =
              (parsed && typeof parsed === "object" && "error" in parsed
                ? JSON.stringify((parsed as { error: unknown }).error)
                : "") ||
              stderr.trim() ||
              err.message;
            reject(new Error(`link-cli ${args[0] ?? ""} failed: ${detail.slice(0, 500)}`));
            return;
          }
          if (parsed === undefined) {
            reject(new Error(`link-cli ${args[0] ?? ""} did not return JSON`));
            return;
          }
          resolve(parsed);
        },
      );
    });
}
