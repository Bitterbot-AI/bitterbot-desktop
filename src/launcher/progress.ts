/**
 * Short, calm launcher output on stderr (stdout belongs to the app: a
 * `bitterbot --version` or `--json` caller must see only the app's output).
 * On a TTY the download is one self-updating progress bar; otherwise (a
 * service log, CI, a pipe) a plain line every 25%.
 */

import os from "node:os";

export type LauncherOutput = {
  /** One line of status. */
  say: (line: string) => void;
  /** Called as the download advances. */
  progress: (received: number, total: number | null) => void;
  /** Ends a progress bar line (if one is open). */
  endProgress: () => void;
};

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** `/home/me/.bitterbot/app` -> `~/.bitterbot/app` for display. */
export function tildify(p: string, home: string = os.homedir()): string {
  if (home && (p === home || p.startsWith(`${home}/`))) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

const BAR_WIDTH = 24;
const REDRAW_MS = 100;

export function createLauncherOutput(
  stream: { write: (chunk: string) => unknown; isTTY?: boolean; columns?: number } = process.stderr,
  now: () => number = Date.now,
): LauncherOutput {
  const tty = Boolean(stream.isTTY);
  let barOpen = false;
  let lastDraw = Number.NEGATIVE_INFINITY;
  let lastQuarter = 0;

  const endProgress = () => {
    if (barOpen) {
      stream.write("\n");
      barOpen = false;
    }
  };

  return {
    say: (line) => {
      endProgress();
      stream.write(`${line}\n`);
    },
    endProgress,
    progress: (received, total) => {
      if (!tty) {
        if (!total) {
          return;
        }
        const quarter = Math.floor((received / total) * 4);
        if (quarter > lastQuarter && quarter < 4) {
          lastQuarter = quarter;
          stream.write(
            `  ${quarter * 25}% (${formatMegabytes(received)} of ${formatMegabytes(total)})\n`,
          );
        }
        return;
      }
      const done = total !== null && received >= total;
      const t = now();
      if (!done && t - lastDraw < REDRAW_MS) {
        return;
      }
      lastDraw = t;
      let line: string;
      if (total) {
        const ratio = Math.min(1, received / total);
        const filled = Math.round(ratio * BAR_WIDTH);
        line = `  [${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}] ${String(Math.floor(ratio * 100)).padStart(3)}%  ${formatMegabytes(received)} / ${formatMegabytes(total)}`;
      } else {
        line = `  ${formatMegabytes(received)} downloaded`;
      }
      stream.write(`\r${line}\u001b[K`);
      barOpen = true;
      if (done) {
        endProgress();
      }
    },
  };
}
