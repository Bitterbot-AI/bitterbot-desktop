/**
 * PLAN-62: the addresses a phone can open this gateway at, best first.
 *
 * A pairing QR shown on the desktop is useless if it says `localhost`. The
 * gateway knows how it is reachable: an explicit `gateway.mobile.publicUrl`,
 * Tailscale Serve/Funnel (a trusted HTTPS name, which also unlocks install and
 * notifications on the phone), or a LAN/tailnet bind.
 */

import os from "node:os";
import type { BitterbotConfig } from "../../config/config.js";
import { getTailnetHostname } from "../../infra/tailscale.js";
import { normalizeControlUiBasePath } from "../control-ui-shared.js";

export type MobileBaseUrl = {
  /** Origin plus base path, no trailing slash: `https://box.tailnet.ts.net`. */
  url: string;
  label: string;
  /** HTTPS: install to home screen and notifications work. */
  secure: boolean;
};

const DEFAULT_GATEWAY_PORT = 19001;

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

function isTailnetIPv4(address: string): boolean {
  const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
  return a === 100 && b >= 64 && b <= 127;
}

function listIPv4(filter: (address: string) => boolean): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === "IPv4" || String(entry.family) === "4";
      if (!entry.internal && isIpv4 && entry.address && filter(entry.address)) {
        out.push(entry.address);
      }
    }
  }
  return [...new Set(out)];
}

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export async function resolveMobileBaseUrls(
  cfg: BitterbotConfig,
  deps: { tailnetHostname?: () => Promise<string | null>; port?: number } = {},
): Promise<MobileBaseUrl[]> {
  const out: MobileBaseUrl[] = [];
  const add = (entry: MobileBaseUrl) => {
    if (!out.some((existing) => existing.url === entry.url)) {
      out.push(entry);
    }
  };
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const port = deps.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT;
  const scheme = cfg.gateway?.tls?.enabled === true ? "https" : "http";

  const configured = cfg.gateway?.mobile?.publicUrl;
  if (typeof configured === "string" && configured.trim()) {
    const url = normalizeOrigin(configured);
    if (url) {
      add({ url, label: "Configured address", secure: url.startsWith("https:") });
    }
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const lookup = deps.tailnetHostname ?? (() => getTailnetHostname().catch(() => null));
    const host = await lookup().catch(() => null);
    if (host) {
      add({
        url: `https://${host.replace(/\.$/, "")}${basePath}`,
        label: tailscaleMode === "funnel" ? "Tailscale Funnel" : "Tailscale",
        secure: true,
      });
    }
  }

  const bind = cfg.gateway?.bind ?? "loopback";
  if (bind === "custom") {
    const host = cfg.gateway?.customBindHost?.trim();
    if (host && host !== "0.0.0.0") {
      add({
        url: `${scheme}://${host}:${port}${basePath}`,
        label: "Custom bind",
        secure: scheme === "https",
      });
    }
  }
  if (bind === "tailnet" || bind === "lan" || bind === "custom") {
    for (const ip of listIPv4(isTailnetIPv4)) {
      add({
        url: `${scheme}://${ip}:${port}${basePath}`,
        label: "Tailnet IP",
        secure: scheme === "https",
      });
    }
  }
  if (bind === "lan" || bind === "custom") {
    for (const ip of listIPv4(isPrivateIPv4)) {
      add({
        url: `${scheme}://${ip}:${port}${basePath}`,
        label: "Home network",
        secure: scheme === "https",
      });
    }
  }
  return out;
}

/** The link a phone opens to claim a setup code. The code rides in the fragment. */
export function buildMobilePairUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m/#pair=${encodeURIComponent(code)}`;
}
