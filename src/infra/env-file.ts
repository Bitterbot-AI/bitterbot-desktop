import fs from "node:fs";
import path from "node:path";
import { escapeRegExp, resolveConfigDir } from "../utils.js";

export function upsertSharedEnvVar(params: {
  key: string;
  value: string;
  env?: NodeJS.ProcessEnv;
}): { path: string; updated: boolean; created: boolean } {
  const env = params.env ?? process.env;
  const dir = resolveConfigDir(env);
  const filepath = path.join(dir, ".env");
  const key = params.key.trim();
  const value = params.value;

  let raw = "";
  if (fs.existsSync(filepath)) {
    raw = fs.readFileSync(filepath, "utf8");
  }

  // Drop the final newline first, so each write does not add a blank line.
  const body = raw.replace(/\r?\n$/, "");
  const lines = body.length ? body.split(/\r?\n/) : [];
  const matcher = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}\\s*=`);
  let updated = false;
  let replaced = false;

  const nextLines = lines.map((line) => {
    const match = line.match(matcher);
    if (!match) {
      return line;
    }
    replaced = true;
    const prefix = match[1] ?? "";
    const next = `${prefix}${key}=${value}`;
    if (next !== line) {
      updated = true;
    }
    return next;
  });

  if (!replaced) {
    nextLines.push(`${key}=${value}`);
    updated = true;
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const output = `${nextLines.join("\n")}\n`;
  // Secrets live here: created 0600 (never briefly world-readable), and an
  // existing file is tightened to 0600 too.
  fs.writeFileSync(filepath, output, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filepath, 0o600);
  } catch {
    // Best effort (Windows ACLs).
  }

  return { path: filepath, updated, created: !raw };
}
