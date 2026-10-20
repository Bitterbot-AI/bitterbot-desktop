/**
 * PLAN-45 4.5 (I9): behavior versus spec. A validation trial records every
 * egress attempt, and a host the SKILL.md frontmatter does not declare
 * under `bitterbot.capabilities.network.outbound` is refused at the tool
 * chokepoint and turned into a REJECT by the gate, with the host named.
 *
 * Scope: skill-evolution validation sessions only (one string check on the
 * hot path; zero cost elsewhere). The declared set is bound per trial by
 * the workspace the runner registered, the same handle the exec tool runs
 * in, so no session key has to travel from the runner to the hook.
 */

import path from "node:path";
import { isSkillEvolveValidationSessionKey } from "../../sessions/session-key-utils.js";
import { parseFrontmatter, resolveBitterbotMetadata } from "./frontmatter.js";

export interface EgressAttempt {
  tool: string;
  host: string;
  declared: boolean;
  at: number;
}

const declaredByWorkspace = new Map<string, string[]>();
const attemptsByWorkspace = new Map<string, EgressAttempt[]>();
const MAX_TRACKED = 256;

function bound<T>(map: Map<string, T>): void {
  if (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

/** Hosts the SKILL.md declares (`bitterbot.capabilities.network.outbound`); empty = none. */
export function declaredHosts(skillMd: string): string[] {
  try {
    const fm = parseFrontmatter(skillMd);
    const caps = resolveBitterbotMetadata(fm)?.capabilities;
    const net = caps?.network as { outbound?: string[] } | false | undefined;
    if (!net || typeof net !== "object") {
      return [];
    }
    return [...new Set((net.outbound ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function hostDeclared(host: string, declared: readonly string[]): boolean {
  const h = host.toLowerCase();
  return declared.some((allowed) => {
    if (allowed === "*") {
      return true;
    }
    if (allowed.startsWith("*.")) {
      return h.endsWith(allowed.slice(1));
    }
    return allowed === h;
  });
}

const URL_RE = /\bhttps?:\/\/([^\s/:'"`<>]+)/gi;
// The command segment after a network CLI, up to a shell separator; every
// token in it is tried as a host (adversarial 4-4: flag values must neither
// swallow the host nor be mistaken for it, so numeric and quoted tokens are
// skipped and the first host-shaped token wins).
const NET_CLI_RE =
  /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|telnet|ftp|dig|nslookup|host|ping|traceroute)\b([^|;&<>`]*)/gi;

function hostFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function hostFromToken(token: string): string | null {
  let t = token.trim();
  if (!t || t.startsWith("-")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return hostFromUrl(t);
  }
  t = t
    .replace(/^[^@]*@/, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/i.test(t) || !t.includes(".")) {
    return null;
  }
  if (/^\d+(\.\d+){3}$/.test(t) && t.startsWith("127.")) {
    return null;
  }
  return t.toLowerCase();
}

/** Hosts a tool call would reach, from its params alone (before the call). */
export function egressHosts(toolName: string, params: unknown): string[] {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const out = new Set<string>();
  if (
    /^(web_fetch|fetch_url|http_get|http_post|browser_fetch|browser)$/.test(name) ||
    name.endsWith("_fetch")
  ) {
    for (const key of ["url", "target", "href"]) {
      const v = p[key];
      if (typeof v === "string") {
        const h = hostFromUrl(v);
        if (h) {
          out.add(h);
        }
      }
    }
  } else if (name === "web_search") {
    out.add("search-provider");
  } else if (name === "exec" || name === "process" || name === "bash" || name === "shell") {
    const command = typeof p.command === "string" ? p.command : "";
    for (const m of command.matchAll(URL_RE)) {
      const h = hostFromToken(m[1] ?? "");
      if (h) {
        out.add(h);
      }
    }
    for (const m of command.matchAll(NET_CLI_RE)) {
      for (const token of (m[1] ?? "").split(/\s+/)) {
        if (!token || token.startsWith("-") || /^\d+$/.test(token) || /['"]/.test(token)) {
          continue;
        }
        const h = hostFromToken(token);
        if (h) {
          out.add(h);
          break;
        }
      }
    }
  }
  return [...out];
}

/** Bind the arm's declared hosts to the trial workspace (runner side). */
export function registerTrialDeclaredHosts(workspaceDir: string, hosts: readonly string[]): void {
  const key = path.resolve(workspaceDir);
  declaredByWorkspace.set(key, [...hosts]);
  attemptsByWorkspace.set(key, []);
  bound(declaredByWorkspace);
  bound(attemptsByWorkspace);
}

/** Take (and forget) the trial's egress record (runner side). */
export function collectTrialEgress(workspaceDir: string): EgressAttempt[] {
  const key = path.resolve(workspaceDir);
  const attempts = attemptsByWorkspace.get(key) ?? [];
  attemptsByWorkspace.delete(key);
  declaredByWorkspace.delete(key);
  return attempts;
}

/**
 * The hook (tool side). Records every egress host of a validation-session
 * tool call; returns a block reason for an undeclared one. Null = proceed.
 */
export function checkValidationEgress(params: {
  toolName: string;
  params: unknown;
  sessionKey?: string;
  workspaceDir?: string;
  now?: number;
}): { block: string | null; hosts: string[] } {
  if (!isSkillEvolveValidationSessionKey(params.sessionKey)) {
    return { block: null, hosts: [] };
  }
  const hosts = egressHosts(params.toolName, params.params);
  if (hosts.length === 0) {
    return { block: null, hosts };
  }
  const key = params.workspaceDir ? path.resolve(params.workspaceDir) : "";
  const declared = declaredByWorkspace.get(key);
  if (!declared) {
    // No trial registered this workspace (a sandbox substituted its own
    // dir, or a non-runner validation turn): never block on a missing
    // registration; nothing is recorded either. Documented limit.
    return { block: null, hosts };
  }
  const attempts = attemptsByWorkspace.get(key) ?? [];
  const undeclared: string[] = [];
  for (const host of hosts) {
    const ok = hostDeclared(host, declared);
    attempts.push({ tool: params.toolName, host, declared: ok, at: params.now ?? Date.now() });
    if (!ok) {
      undeclared.push(host);
    }
  }
  attemptsByWorkspace.set(key, attempts.slice(-64));
  if (undeclared.length === 0) {
    return { block: null, hosts };
  }
  return {
    block: `EGRESS-DENIED: this validation trial attempted ${params.toolName} to ${undeclared.map((h) => `"${h}"`).join(", ")}, which the skill's frontmatter does not declare under bitterbot.capabilities.network.outbound${declared.length > 0 ? ` (declared: ${declared.join(", ")})` : " (nothing declared)"}.`,
    hosts,
  };
}

export function resetValidationEgressForTest(): void {
  declaredByWorkspace.clear();
  attemptsByWorkspace.clear();
}
