import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { renderQrPngBase64 } from "../web/qr-image.js";

const log = createSubsystemLogger("signal/link-qr");

/**
 * Device-link QR flow for Signal, mirroring the WhatsApp web.login.* shape:
 * start spawns `signal-cli link -n <name>`, captures the linking URI it
 * prints, and returns it as a QR data URL; wait resolves when signal-cli
 * exits (it exits 0 once the phone scans the QR and the link completes).
 *
 * signal-cli's URI scheme has changed across versions (tsdevice:/ then
 * sgnl://linkdevice); parsing is tolerant of both plus whatever whitespace
 * or log prefixes surround them.
 */

const URI_PATTERNS = [/sgnl:\/\/linkdevice[^\s"']*/i, /tsdevice:\/[^\s"']*/i];
const DEFAULT_URI_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
/** A pending link older than this is considered stale and restarted. */
const LINK_FRESH_MS = 10 * 60_000;

export type SignalLinkSpawn = (
  cliPath: string,
  args: string[],
) => Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "on" | "kill" | "killed">;

type ActiveLink = {
  child: ReturnType<SignalLinkSpawn>;
  qrDataUrl?: string;
  startedAt: number;
  done: Promise<{ connected: boolean; message: string }>;
  settled: boolean;
};

const activeLinks = new Map<string, ActiveLink>();

export function extractSignalLinkUri(chunk: string): string | null {
  for (const pattern of URI_PATTERNS) {
    const match = chunk.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function extractLinkedNumber(output: string): string | null {
  const match = output.match(/Associated with:\s*(\+\d+)/i);
  return match ? match[1] : null;
}

export function resetSignalLinkForTest(accountId?: string): void {
  if (accountId) {
    activeLinks.delete(accountId);
    return;
  }
  activeLinks.clear();
}

export async function startSignalLinkQr(params: {
  accountId: string;
  cliPath: string;
  deviceName?: string;
  uriTimeoutMs?: number;
  spawnFn?: SignalLinkSpawn;
}): Promise<{ qrDataUrl?: string; message: string }> {
  const existing = activeLinks.get(params.accountId);
  if (existing && !existing.settled && Date.now() - existing.startedAt < LINK_FRESH_MS) {
    if (existing.qrDataUrl) {
      return {
        qrDataUrl: existing.qrDataUrl,
        message: "Scan this QR in Signal → Settings → Linked Devices.",
      };
    }
    // Still waiting on the URI from a just-started attempt; fall through and
    // replace it so the caller is never stuck behind a wedged child.
  }
  if (existing) {
    try {
      existing.child.kill();
    } catch {
      // Already dead.
    }
    activeLinks.delete(params.accountId);
  }

  const spawnFn: SignalLinkSpawn =
    params.spawnFn ?? ((cliPath, args) => spawn(cliPath, args, { stdio: "pipe" }));
  let child: ReturnType<SignalLinkSpawn>;
  try {
    child = spawnFn(params.cliPath, ["link", "-n", params.deviceName ?? "Bitterbot"]);
  } catch (err) {
    return { message: `Failed to start signal-cli: ${String(err)}` };
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let resolveUri: (uri: string | null) => void = () => {};
  const uriPromise = new Promise<string | null>((resolve) => {
    resolveUri = resolve;
  });

  child.stdout.on("data", (data: Buffer) => {
    stdoutBuf += String(data);
    const uri = extractSignalLinkUri(stdoutBuf);
    if (uri) {
      resolveUri(uri);
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderrBuf += String(data);
    // Some signal-cli builds log the URI to stderr.
    const uri = extractSignalLinkUri(stderrBuf);
    if (uri) {
      resolveUri(uri);
    }
  });

  const link: ActiveLink = {
    child,
    startedAt: Date.now(),
    settled: false,
    done: new Promise((resolve) => {
      child.on("error", (err: Error) => {
        link.settled = true;
        resolveUri(null);
        resolve({ connected: false, message: `signal-cli error: ${err.message}` });
      });
      child.on("exit", (code: number | null) => {
        link.settled = true;
        resolveUri(null);
        if (code === 0) {
          const number = extractLinkedNumber(stdoutBuf + stderrBuf);
          resolve({
            connected: true,
            message: number
              ? `Linked to ${number}. Set this number as the account in the Signal channel config.`
              : "Device linked. Configure the account number to finish setup.",
          });
          return;
        }
        const detail = stderrBuf.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        resolve({
          connected: false,
          message: `signal-cli link exited with code ${code}${detail ? `: ${detail}` : ""}`,
        });
      });
    }),
  };
  activeLinks.set(params.accountId, link);

  const uriTimeout = params.uriTimeoutMs ?? DEFAULT_URI_TIMEOUT_MS;
  const uri = await Promise.race([
    uriPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), uriTimeout).unref?.()),
  ]);
  if (!uri) {
    try {
      child.kill();
    } catch {
      // Already dead.
    }
    activeLinks.delete(params.accountId);
    const detail = (stderrBuf || stdoutBuf).trim().split("\n").slice(-2).join(" ").slice(0, 400);
    return {
      message: `signal-cli did not produce a linking URI${detail ? ` (${detail})` : ""}. Check that "${params.cliPath}" is signal-cli and up to date.`,
    };
  }

  try {
    const base64 = await renderQrPngBase64(uri);
    link.qrDataUrl = `data:image/png;base64,${base64}`;
  } catch (err) {
    log.error(`QR render failed: ${String(err)}`);
    return { message: `Failed to render QR: ${String(err)}` };
  }
  return {
    qrDataUrl: link.qrDataUrl,
    message: "Scan this QR in Signal → Settings → Linked Devices.",
  };
}

export async function waitForSignalLinkQr(params: {
  accountId: string;
  timeoutMs?: number;
}): Promise<{ connected: boolean; message: string }> {
  const link = activeLinks.get(params.accountId);
  if (!link) {
    return { connected: false, message: "No Signal link in progress. Start one first." };
  }
  const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const result = await Promise.race([
    link.done,
    new Promise<{ connected: boolean; message: string }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            connected: false,
            message:
              "Timed out waiting for the QR scan. The QR stays valid; wait again or restart the link.",
          }),
        timeoutMs,
      ).unref?.(),
    ),
  ]);
  if (link.settled) {
    activeLinks.delete(params.accountId);
  }
  return result;
}
