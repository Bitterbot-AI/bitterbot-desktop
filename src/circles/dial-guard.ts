/**
 * SSRF guard for peer-supplied dial targets (PLAN-36 §4 follow-up (b)).
 *
 * Every URL a circles node dials arrives from a peer: invite envelopes carry
 * the inviter's a2a + mailbox URLs, rosters and presence carry member URLs,
 * and mailbox rendezvous blobs carry rendezvous URLs. Before this guard the
 * node would POST to whatever a peer supplied (`https?` was the only check) —
 * a hostile peer could aim it at loopback (the gateway's own loopback RPC),
 * link-local metadata services (169.254.169.254), or hosts on the node's LAN.
 *
 * This is a SYNTACTIC guard: scheme, credentials, hostname class, and literal
 * IP ranges. DNS rebinding (a public hostname resolving to a private address)
 * is not covered — that needs resolver pinning at the fetch layer and is a
 * known follow-up, not an accident. Nodes on a trusted LAN that legitimately
 * dial private peers can opt out with `circles.dial.allowPrivate: true`.
 */

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function ipv4Blocked(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Not a well-formed dotted quad — treat as a hostname, not an IP.
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 test-net
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

function ipv6Blocked(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false; // not an IPv6 literal
  if (host === "::" || host === "::1") return true; // unspecified, loopback
  // IPv4-mapped forms carry the v4 semantics. WHATWG URL normalizes
  // "[::ffff:127.0.0.1]" to hex hextets ("[::ffff:7f00:1]"), so decode both
  // spellings; an unparseable mapped form is refused outright (fail closed).
  if (host.startsWith("::ffff:")) {
    const tail = host.slice("::ffff:".length);
    if (tail.includes(".")) return ipv4Blocked(tail);
    const groups = tail.split(":").map((g) => parseInt(g || "0", 16));
    if (groups.length <= 2 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)) {
      const hi = groups.length === 2 ? (groups[0] as number) : 0;
      const lo = (groups.length === 2 ? groups[1] : groups[0]) as number;
      return ipv4Blocked(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true;
  }
  // Dotted-quad tails on other v6 forms (compat addresses) keep v4 semantics.
  const v4Tail = /(?:\d{1,3}\.){3}\d{1,3}$/.exec(host);
  if (v4Tail) return ipv4Blocked(v4Tail[0]);
  const firstHextet = host.split(":", 1)[0] ?? "";
  if (firstHextet.startsWith("fc") || firstHextet.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
  return false;
}

/**
 * Returns a human-readable refusal reason when `raw` must not be dialed, or
 * null when it is an acceptable public dial target.
 */
export function publicDialUrlError(raw: string, opts?: { allowPrivate?: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `scheme ${url.protocol.replace(/:$/, "")} is not dialable`;
  }
  if (url.username || url.password) {
    return "credentials in dial URLs are refused";
  }
  if (opts?.allowPrivate === true) {
    return null; // trusted-LAN opt-out: scheme/credential checks still apply
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return `hostname ${host} is not a public dial target`;
  }
  if (ipv4Blocked(host)) {
    return `address ${host} is in a private or reserved range`;
  }
  if (ipv6Blocked(host)) {
    return `address ${host} is in a private or reserved range`;
  }
  return null;
}
