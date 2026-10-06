import fs from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "./types.js";

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function serversFile(stateDir: string): string {
  return path.join(stateDir, "mcp", "servers.json");
}

export async function loadServers(file: string): Promise<McpServerSpec[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { servers?: unknown };
    return Array.isArray(parsed.servers) ? (parsed.servers as McpServerSpec[]) : [];
  } catch {
    return [];
  }
}

export async function saveServers(file: string, servers: McpServerSpec[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // Headers and env can hold API keys.
  await fs.writeFile(tmp, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stringMap(v: unknown, label: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${label} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw new Error(`${label}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

/** Check a server the owner is adding. Throws with a message they can act on. */
export function parseServerSpec(input: Record<string, unknown>): McpServerSpec {
  const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new Error("name: lowercase letters, digits, - and _, up to 32 characters");
  }
  const transport =
    input.transport === "stdio" ? "stdio" : input.transport === "http" ? "http" : null;
  if (!transport) {
    throw new Error('transport must be "stdio" (a local program) or "http" (a remote server)');
  }
  const spec: McpServerSpec = {
    name,
    transport,
    enabled: input.enabled !== false,
    trustWrites: input.trustWrites === true,
  };
  if (transport === "stdio") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) throw new Error("command is required for a local (stdio) server");
    spec.command = command;
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.some((a) => typeof a !== "string")) {
        throw new Error("args must be a list of strings");
      }
      spec.args = input.args as string[];
    }
    spec.env = stringMap(input.env, "env");
  } else {
    let url: URL;
    try {
      url = new URL(String(input.url ?? ""));
    } catch {
      throw new Error("url must be the server's full address");
    }
    const local =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new Error("a remote server must use https (plain http only for this machine)");
    }
    spec.url = url.toString();
    spec.headers = stringMap(input.headers, "headers");
  }
  return spec;
}
