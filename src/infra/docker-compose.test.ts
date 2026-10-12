/**
 * PLAN-56 Phase 2: the repo's docker-compose.yml must work with zero edits.
 * Parses the file and checks the promises docs/platforms/docker.md makes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const COMPOSE_PATH = path.resolve(import.meta.dirname, "../../docker-compose.yml");
const RAW = fs.readFileSync(COMPOSE_PATH, "utf-8");
// Comments may show example overrides; only the live YAML counts.
const LIVE = RAW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

type Service = {
  image?: string;
  user?: string;
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  command?: string[];
  entrypoint?: string[];
  profiles?: string[];
};

const doc = parse(RAW, { merge: true }) as { services: Record<string, Service> };
const gateway = doc.services["bitterbot-gateway"];

/**
 * Minimal Compose interpolation for `${VAR:-default}` (nested defaults
 * included) with an EMPTY environment, which is what a zero-edit run sees.
 */
function interpolateWithEmptyEnv(value: string): string {
  let out = value;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(/\$\{([A-Z0-9_]+):-([^${}]*)\}/g, (_m, _name, def: string) => def);
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

describe("docker-compose.yml (zero-edit compose)", () => {
  it("every variable has a default: nothing is required", () => {
    const refs = [...LIVE.matchAll(/\$\{([^}]*)\}?/g)].map((m) => m[1] ?? "");
    expect(refs.length).toBeGreaterThan(0);
    const required = refs.filter((ref) => !/^[A-Z0-9_]+:-/.test(ref));
    expect(required).toEqual([]);
    // After interpolating an empty env, nothing is left unresolved.
    for (const service of Object.values(doc.services)) {
      for (const field of [
        service.image ?? "",
        ...(service.volumes ?? []),
        ...(service.ports ?? []),
        ...(service.command ?? []),
      ]) {
        expect(interpolateWithEmptyEnv(field), field).not.toContain("$");
      }
    }
  });

  it("binds the Control UI and the P2P port to loopback by default", () => {
    const ports = (gateway.ports ?? []).map(interpolateWithEmptyEnv);
    expect(ports).toEqual(["127.0.0.1:19001:19001", "127.0.0.1:9100:9100"]);
    expect(gateway.ports?.[0]).toContain("${BITTERBOT_BIND_HOST:-127.0.0.1}");
    expect(gateway.ports?.[1]).toContain("${BITTERBOT_P2P_BIND_HOST:-127.0.0.1}");
  });

  it("keeps data in a visible folder next to the compose file, workspace inside it", () => {
    const volumes = (gateway.volumes ?? []).map(interpolateWithEmptyEnv);
    expect(volumes).toEqual([
      "./bitterbot-data:/home/node/.bitterbot",
      "./bitterbot-data/workspace:/home/node/.bitterbot/workspace",
    ]);
  });

  it("has a healthcheck, restarts unless stopped, and pins the major image tag", () => {
    expect(gateway.healthcheck?.test?.join(" ")).toContain("http://127.0.0.1:19001/");
    expect(gateway.restart).toBe("unless-stopped");
    expect(interpolateWithEmptyEnv(gateway.image ?? "")).toBe(
      "ghcr.io/bitterbot-ai/bitterbot-desktop:1",
    );
    expect(LIVE).not.toMatch(/:latest\b/);
  });

  it("starts fresh installs unconfigured with bootstrap pairing and a generated token", () => {
    expect(gateway.command).toContain("--allow-unconfigured");
    expect(gateway.environment?.BITTERBOT_BOOTSTRAP_PAIRING).toBe("1");
    // Empty by default: the gateway generates and persists one on first boot.
    expect(interpolateWithEmptyEnv(gateway.environment?.BITTERBOT_GATEWAY_TOKEN ?? "x")).toBe("");
  });

  it("starts as root only through the image entrypoint, which drops to `node`", () => {
    expect(gateway.user).toBe("0:0");
    // Named explicitly: an image without it (1.4.x) fails to start instead
    // of running the gateway as root.
    expect(gateway.entrypoint).toEqual(["/app/scripts/docker-entrypoint.sh"]);
    const scripts = path.resolve(import.meta.dirname, "../../scripts");
    const entrypoint = fs.readFileSync(path.join(scripts, "docker-entrypoint.sh"), "utf-8");
    const lib = fs.readFileSync(path.join(scripts, "docker-entrypoint-lib.sh"), "utf-8");
    expect(entrypoint).toMatch(/setpriv --reuid=node --regid=node --init-groups --no-new-privs/);
    expect(entrypoint).toContain("HOME=/home/node");
    expect(entrypoint).toContain("bb_uid_map_is_identity");
    // Only root-owned entries, one filesystem, no recursive chown across mounts.
    expect(lib).toMatch(/-xdev/);
    expect(lib).toMatch(/-uid "\$match_uid" -exec chown -h/);
    expect(`${entrypoint}\n${lib}`).not.toMatch(/chown -R/);
    const dockerfile = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]');
    expect(dockerfile).toContain("ENV BITTERBOT_INSTALL_KIND=container");
    expect(dockerfile).toContain("ENV HOME=/home/node");
  });

  it("pre-creates the data dir owned by node before dropping to USER node (named volumes)", () => {
    const dockerfile = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../Dockerfile"),
      "utf-8",
    );
    const mkdir = dockerfile.indexOf(
      "RUN mkdir -p /home/node/.bitterbot && chown node:node /home/node/.bitterbot",
    );
    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(dockerfile.indexOf("\nUSER node"));
  });

  it("gives cold boots five minutes before the healthcheck counts", () => {
    expect((gateway.healthcheck as { start_period?: string }).start_period).toBe("300s");
  });

  it("pins image versions that carry the entrypoint in its examples", () => {
    expect(RAW).not.toMatch(/bitterbot-desktop:1\.4\./);
    expect(RAW).toContain("releases/latest/download/docker-compose.yml");
  });

  it("does not start the CLI helper with `up`", () => {
    expect(doc.services["bitterbot-cli"]?.profiles).toEqual(["cli"]);
    expect(doc.services["bitterbot-cli"]?.entrypoint?.[0]).toBe(
      "/app/scripts/docker-entrypoint.sh",
    );
  });
});
