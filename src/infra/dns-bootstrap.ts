/**
 * DNS Bootstrap Discovery for P2P networks.
 *
 * Resolves `_dnsaddr.<domain>` TXT records to discover bootstrap peer
 * multiaddresses, following the dnsaddr multiaddr spec used by IPFS/libp2p.
 *
 * DNS record format (one TXT record per peer):
 *   _dnsaddr.p2p.example.com  TXT  "dnsaddr=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooW..."
 *
 * This allows adding/removing bootstrap peers by updating DNS — no config
 * changes needed on edge nodes.
 */

import { promises as dns } from "node:dns";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("p2p/dns-bootstrap");

const DNSADDR_PREFIX = "dnsaddr=";
const DNS_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

/**
 * Resolve bootstrap peer multiaddresses from DNS TXT records.
 *
 * Looks up `_dnsaddr.<domain>` and extracts multiaddresses from TXT records
 * that follow the format: `dnsaddr=/ip4/.../tcp/.../p2p/12D3KooW...`
 *
 * @param domain - The bootstrap DNS domain (e.g., "p2p.bitterbot.ai")
 * @returns Array of multiaddress strings
 */
export async function resolveBootstrapDns(domain: string): Promise<string[]> {
  const hostname = `_dnsaddr.${domain}`;
  log.info(`Resolving bootstrap peers from ${hostname}`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const records = await Promise.race([
        dns.resolveTxt(hostname),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS}ms`)),
            DNS_TIMEOUT_MS,
          ),
        ),
      ]);
      const multiaddrs: string[] = [];

      for (const record of records) {
        // TXT records can be split across multiple strings; join them
        const txt = record.join("");
        if (txt.startsWith(DNSADDR_PREFIX)) {
          const multiaddr = txt.slice(DNSADDR_PREFIX.length).trim();
          if (multiaddr.length > 0 && multiaddr.startsWith("/")) {
            multiaddrs.push(multiaddr);
          }
        }
      }

      if (multiaddrs.length > 0) {
        log.info(`Resolved ${multiaddrs.length} bootstrap peer(s) from DNS`);
        for (const addr of multiaddrs) {
          log.debug(`  ${addr}`);
        }
      } else {
        log.info(`No dnsaddr records found at ${hostname}`);
      }

      return multiaddrs;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;

      // ENODATA / ENOTFOUND = domain exists but no TXT records, or domain doesn't exist
      // These are not transient — don't retry
      if (code === "ENODATA" || code === "ENOTFOUND") {
        log.debug(`No DNS records at ${hostname} (${code})`);
        return [];
      }

      // Transient errors — retry
      if (attempt < MAX_RETRIES) {
        log.debug(`DNS lookup failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${String(err)}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      log.warn(`DNS bootstrap resolution failed after ${MAX_RETRIES + 1} attempts: ${String(err)}`);
      return [];
    }
  }

  return [];
}

/**
 * Merge DNS-discovered bootstrap peers with any hardcoded peers from config.
 * Deduplicates by full multiaddress string.
 */
export function mergeBootstrapPeers(
  configPeers: string[] | undefined,
  dnsPeers: string[],
): string[] {
  const all = [...(configPeers ?? []), ...dnsPeers];
  return [...new Set(all)];
}
