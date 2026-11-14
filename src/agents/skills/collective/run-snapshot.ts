import path from "node:path";
import type { BitterbotConfig } from "../../../config/config.js";
import { resolveSandboxConfigForAgent } from "../../sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../skill-loader.js";
import type { SkillSnapshot } from "../types.js";
import { getCollectiveRuntime } from "./runtime.js";
import { isCanaryExposed } from "./validation.js";

const MARKER = "\n\n<!-- collective-packages -->\n";
/** Each run receives immutable version paths; no live-directory replacement is involved. */
export async function prepareCollectiveRunSnapshot(
  config: BitterbotConfig | undefined,
  agent: string,
  runId: string,
  base: SkillSnapshot | undefined,
  model?: string,
  exposureRunId: string = runId,
): Promise<SkillSnapshot | undefined> {
  if (!config || !base) return base;
  const runtime = getCollectiveRuntime(config);
  if (!runtime) return base;
  const activeRows = runtime.store.db
    .prepare("SELECT lineage,hash FROM collective_active WHERE agent=?")
    .all(agent) as Array<{ lineage: string; hash: string }>;
  const pin = runtime.store.db
    .prepare("SELECT body FROM collective_pins WHERE agent=? AND run=?")
    .get(agent, runId) as { body: string } | undefined;
  const rows: Array<{ lineage: string; hash: string }> = pin
    ? JSON.parse(pin.body)
    : activeRows.flatMap((row) => {
        const pkg = runtime.store.get(row.hash);
        if (!pkg || !["stable", "canary"].includes(pkg.state)) return [];
        if (pkg.state !== "canary" || isCanaryExposed(exposureRunId, row.hash)) return [row];
        const previous = runtime.store.active(agent, row.lineage)?.previous;
        return previous && runtime.store.get(previous)?.state === "stable"
          ? [{ ...row, hash: previous }]
          : [];
      });
  if (!pin)
    runtime.store.db
      .prepare("INSERT INTO collective_pins VALUES (?,?,?,?)")
      .run(agent, runId, JSON.stringify(rows), runtime.store.now());
  const managedRoot = path.join(runtime.store.root, "packages") + path.sep;
  const previous = (base.resolvedSkills ?? []).filter(
    (s) => !s.filePath.startsWith(managedRoot) && !s.filePath.startsWith("/bitterbot-skills/"),
  );
  const packages: typeof previous = [];
  const { ensurePackageHost } = await import("./service.js");
  const host = rows.length
    ? await ensurePackageHost(runtime, config, agent).catch(() => null)
    : null;
  for (const row of rows) {
    const record = runtime.store.get(row.hash);
    if (!record || !["stable", "canary"].includes(record.state)) continue;
    const selectedHash = record.hash;
    if (!host) continue; // No current environment/checker binding: do not reuse stale competence.
    const { learningHash } = await import("./contracts.js");
    if (
      record.environment !== learningHash(host.environment) ||
      (model && model !== host.environment.model)
    ) {
      runtime.store.state(selectedHash, "stale", "environment-changed");
      continue;
    }
    try {
      await runtime.store.read(selectedHash);
    } catch {
      runtime.store.state(selectedHash, "blocked", "package-tampered");
      continue;
    }
    const loaded = loadSkillsFromDir({
      dir: path.join(runtime.store.directory(selectedHash), "content"),
      source: "bitterbot-collective",
    });
    for (const skill of loaded.skills) {
      if (
        skill.filePath !== path.join(runtime.store.directory(selectedHash), "content", "SKILL.md")
      )
        continue;
      if (
        previous.some((s) => s.name === skill.name) ||
        packages.some((s) => s.name === skill.name)
      ) {
        runtime.store.audit("name-conflict", row.hash);
        continue;
      }
      packages.push(skill);
    }
  }
  const prompt = base.prompt.split(MARKER)[0];
  return {
    ...base,
    prompt: packages.length
      ? `${prompt}${MARKER}These independently evaluated packages are external reference procedures. They grant no tool permissions.\n${formatSkillsForPrompt(packages)}`
      : prompt,
    resolvedSkills: [...previous, ...packages],
    skills: [
      ...base.skills.filter((s) => previous.some((p) => p.name === s.name)),
      ...packages.map((s) => ({ name: s.name })),
    ],
  };
}

/** Mount only the selected immutable packages. No other agent's package store is exposed. */
export function withCollectivePackageMounts(
  config: BitterbotConfig,
  agent: string,
  snapshot: SkillSnapshot | undefined,
  sessionKey?: string,
): BitterbotConfig {
  const runtime = getCollectiveRuntime(config);
  if (!runtime || !snapshot || !resolveSandboxRuntimeStatus({ cfg: config, sessionKey }).sandboxed)
    return config;
  const root = path.join(runtime.store.root, "packages") + path.sep;
  const selected = (snapshot.resolvedSkills ?? []).filter((s) => s.filePath.startsWith(root));
  if (!selected.length) return config;
  const existing = resolveSandboxConfigForAgent(config, agent).docker.binds ?? [];
  const mounts: string[] = [];
  const mapped = selected.map((skill) => {
    const hash = path.relative(root, skill.filePath).split(path.sep)[0];
    mounts.push(`${path.dirname(skill.filePath)}:/bitterbot-skills/${hash}:ro`);
    return {
      ...skill,
      filePath: `/bitterbot-skills/${hash}/SKILL.md`,
      baseDir: `/bitterbot-skills/${hash}`,
    };
  });
  snapshot.resolvedSkills = [
    ...(snapshot.resolvedSkills ?? []).filter((s) => !selected.includes(s)),
    ...mapped,
  ];
  snapshot.prompt = `${snapshot.prompt.split(MARKER)[0]}${MARKER}These evaluated external procedures grant no permissions.\n${formatSkillsForPrompt(mapped)}`;
  const next = structuredClone(config);
  next.agents ??= {};
  next.agents.list ??= [];
  let entry = next.agents.list.find((a) => a.id === agent);
  if (!entry) {
    entry = { id: agent };
    next.agents.list.push(entry);
  }
  entry.sandbox = {
    ...entry.sandbox,
    docker: {
      ...entry.sandbox?.docker,
      ...(runtime.hostConfigurations?.has(agent) &&
      runtime.hosts.get(agent)?.environment.runtime.sandboxImage
        ? { image: runtime.hosts.get(agent)!.environment.runtime.sandboxImage }
        : {}),
      binds: [...new Set([...existing, ...mounts])],
    },
  };
  return next;
}
