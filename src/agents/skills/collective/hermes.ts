import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { parseFrontmatter } from "../frontmatter.js";
import { learningHash, sha256, type PackageSnapshot } from "./contracts.js";
import { snapshotPackage, verifySnapshot } from "./package.js";
import type { SkillTraceAdapter } from "./trace-adapter.js";

/** Official hermes_wisdom_plugin/contract.py's pinned service schema, checked 2026-11-11. */
export const HERMES_CONTRACT_PIN = {
  pluginCommit: "c443c14dbbf3c8a4d90d613a0456911e087e30a7",
  gatewayCommit: "3fb6fa2b6ab638464fd3d9a6dc6961bcc074aff9",
  manifestSchemaSha256: "64d0010eada1d79fa16309e9fd715faf77b6186360ea0b095182b2bdaeec5714",
  source:
    "https://github.com/NousResearch/hermes-collective-wisdom/blob/c443c14dbbf3c8a4d90d613a0456911e087e30a7/hermes_wisdom_plugin/package.py",
} as const;
const HermesManifestSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().min(1).max(512),
    requirements: z
      .object({
        hermes: z.object({ minimum_version: z.string() }).strict(),
        platforms: z.array(z.string()).default([]),
        architectures: z.array(z.string()).default([]),
        tools: z
          .array(
            z
              .object({
                name: z.string(),
                minimum_version: z.string().nullable().optional(),
                auto_install: z.literal(false).default(false),
                requires_admin: z.boolean().default(false),
              })
              .strict(),
          )
          .default([]),
        runtime: z
          .object({
            shell: z.boolean().default(false),
            browser: z.boolean().default(false),
            code: z.boolean().default(false),
            sandbox: z.boolean().default(true),
          })
          .strict()
          .default({ shell: false, browser: false, code: false, sandbox: true }),
      })
      .passthrough(),
  })
  .strict();
export type CompatibilityReport = {
  compatible: boolean;
  issues: string[];
  sourceHash: string;
  convertedHash: string;
  source: typeof HERMES_CONTRACT_PIN;
  claimedAuthor: string | null;
  sourceRequirements: Record<string, unknown>;
};

export async function importHermesDirectory(
  directory: string,
): Promise<{ snapshot: PackageSnapshot; report: CompatibilityReport }> {
  // Snapshot before reading metadata; use conservative placeholder requirements until converted.
  const initial = await snapshotPackage(directory, {
    name: "hermes-import",
    description: "External Hermes skill.",
    requirements: { platforms: [], tools: {}, capabilities: [], runtime: {} },
  });
  const frontmatter = parseFrontmatter(initial.files.get("SKILL.md")!.toString("utf8"));
  const name = frontmatter.name;
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Error("Hermes skill needs a portable name");
  const raw = initial.files.get("skill.manifest.json");
  if (!raw) throw new Error("Hermes skill.manifest.json is required");
  const hermes = HermesManifestSchema.parse(YAML.parse(raw.toString("utf8"), { uniqueKeys: true }));
  const requirements = hermes.requirements;
  const issues: string[] = [];
  const known = new Set(["hermes", "platforms", "architectures", "tools", "runtime"]);
  for (const [key, value] of Object.entries(requirements)) {
    if (
      !known.has(key) &&
      value !== null &&
      JSON.stringify(value) !== "[]" &&
      JSON.stringify(value) !== "{}"
    )
      issues.push(`Unmapped Hermes requirement: ${key}`);
  }
  if (requirements.architectures.length)
    issues.push(`Architecture requirement: ${requirements.architectures.join(", ")}`);
  for (const tool of requirements.tools) {
    if (tool.requires_admin) issues.push(`Administrative tool requirement: ${tool.name}`);
    if (!tool.minimum_version) issues.push(`Unpinned tool version: ${tool.name}`);
  }
  if (
    initial.files.has("setup.sh") ||
    initial.files.has("setup.py") ||
    initial.files.has("setup.json")
  )
    issues.push("Setup is declarative and requires separate authorization");
  const manifest = {
    ...initial.manifest,
    name,
    description: frontmatter.description ?? hermes.name,
    requirements: {
      platforms: requirements.platforms,
      tools: Object.fromEntries(
        requirements.tools.map((t) => [t.name, t.minimum_version ?? "unversioned"]),
      ),
      capabilities: [
        requirements.runtime.shell ? "shell" : "",
        requirements.runtime.browser ? "browser" : "",
        requirements.runtime.code ? "code" : "",
      ].filter(Boolean),
      // Hermes' framework floor remains in the original manifest and provenance.
      // Requirements without a Bitterbot mapping remain blocking runtime constraints.
      runtime: {
        ...Object.fromEntries(
          Object.entries(requirements)
            .filter(
              ([key, value]) =>
                !known.has(key) &&
                value !== null &&
                JSON.stringify(value) !== "[]" &&
                JSON.stringify(value) !== "{}",
            )
            .map(([key, value]) => [`hermes-unmapped:${key}`, learningHash(value)]),
        ),
        ...(requirements.architectures.length
          ? { "hermes-architectures": requirements.architectures.join(",") }
          : {}),
        ...Object.fromEntries(
          requirements.tools
            .filter((t) => t.requires_admin)
            .map((t) => [`hermes-admin:${t.name}`, "requires-separate-authorization"]),
        ),
      },
    },
  };
  const snapshot = { ...initial, manifest, packageHash: learningHash(manifest) };
  verifySnapshot(snapshot);
  // Hermes hashes exact path/mode/file-hash records, not Bitterbot's manifest.
  const records = initial.manifest.files
    .map((f) => `${f.path} ${f.executable ? "exec" : "file"} sha256:${f.hash}\n`)
    .toSorted()
    .join("");
  return {
    snapshot,
    report: {
      compatible: issues.length === 0,
      issues,
      sourceHash: `sha256:${sha256(records)}`,
      convertedHash: snapshot.packageHash,
      source: HERMES_CONTRACT_PIN,
      claimedAuthor: frontmatter.author ?? null,
      sourceRequirements: requirements,
    },
  };
}

export async function exportHermesDirectory(
  snapshot: PackageSnapshot,
  destination: string,
): Promise<{
  sourcePackageHash: string;
  originalFilesPreserved: number;
  generatedManifest: boolean;
}> {
  verifySnapshot(snapshot);
  let generated: Buffer | null = null;
  if (!snapshot.files.has("skill.manifest.json")) {
    const requirements = snapshot.manifest.requirements;
    const unsupported = [
      ...Object.keys(requirements.runtime).map((r) => `runtime:${r}`),
      ...requirements.capabilities
        .filter((c) => !["shell", "browser", "code"].includes(c))
        .map((c) => `capability:${c}`),
      ...Object.keys(requirements.tools)
        .filter((t) => !["python3", "node", "bash", "git", "curl", "jq"].includes(t))
        .map((t) => `tool:${t}`),
      ...requirements.platforms
        .filter((p) => !["linux", "windows", "win32", "macos", "darwin"].includes(p))
        .map((p) => `platform:${p}`),
    ];
    if (unsupported.length)
      throw new Error(`Hermes compatibility requires explicit mapping: ${unsupported.join(", ")}`);
    const aliases: Record<string, string> = { win32: "windows", darwin: "macos" };
    const mapped = HermesManifestSchema.parse({
      schema_version: 1,
      name: snapshot.manifest.name,
      requirements: {
        hermes: { minimum_version: "0.21.5" },
        platforms: requirements.platforms.map((p) => aliases[p] ?? p),
        architectures: [],
        tools: Object.entries(requirements.tools).map(([name, version]) => ({
          name,
          minimum_version: version === "available" ? null : version,
          auto_install: false,
          requires_admin: false,
        })),
        runtime: {
          shell: requirements.capabilities.includes("shell"),
          browser: requirements.capabilities.includes("browser"),
          code: requirements.capabilities.includes("code"),
          sandbox: true,
        },
      },
    });
    generated = Buffer.from(JSON.stringify(mapped, null, 2) + "\n");
    if (
      snapshot.manifest.files.length + 1 > 128 ||
      [...snapshot.files.values()].reduce((n, b) => n + b.length, generated.length) >
        10 * 1024 * 1024
    )
      throw new Error("Hermes conversion exceeds package limits");
  } else
    HermesManifestSchema.parse(
      YAML.parse(snapshot.files.get("skill.manifest.json")!.toString("utf8"), { uniqueKeys: true }),
    );
  destination = path.resolve(destination);
  if (await fs.lstat(destination).catch(() => null))
    throw new Error("Export destination already exists");
  const temporary = `${destination}.partial-${randomUUID()}`;
  await fs.mkdir(temporary, { recursive: false });
  try {
    for (const file of snapshot.manifest.files) {
      const target = path.join(temporary, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, snapshot.files.get(file.path)!, {
        flag: "wx",
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    if (generated)
      await fs.writeFile(path.join(temporary, "skill.manifest.json"), generated, {
        flag: "wx",
        mode: 0o600,
      });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return {
    sourcePackageHash: snapshot.packageHash,
    originalFilesPreserved: snapshot.files.size,
    generatedManifest: generated !== null,
  };
}

export type ExternalTrace = {
  framework: "hermes";
  taskId: string;
  skillVersion: string;
  sourceHash: string;
  evidence: "unverified";
  environment: Record<string, string>;
  outcomeProvenance: "external-export-without-trusted-checker";
  actions: Array<{ id: string; tool: string; argumentsHash: string; resultHash: string | null }>;
  feedbackHash: string | null;
  costs: null;
};
/** Hermes OpenAI-format message export. Raw arguments/results never enter peer summaries. */
export function importHermesTrace(
  input: string,
  taskId: string,
  skillVersion: string,
): ExternalTrace {
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("Trace too large");
  const messages = z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.unknown().optional(),
        tool_call_id: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal("function"),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
      }),
    )
    .max(1000)
    .parse(JSON.parse(input));
  const actions: ExternalTrace["actions"] = [];
  let feedbackHash: string | null = null;
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (actions.some((a) => a.id === call.id)) throw new Error("Duplicate trace call ID");
      actions.push({
        id: call.id,
        tool: call.function.name,
        argumentsHash: sha256(call.function.arguments),
        resultHash: null,
      });
    }
    if (message.role === "tool") {
      const action = actions.find((a) => a.id === message.tool_call_id);
      if (!action || action.resultHash) throw new Error("Unmatched or duplicate tool result");
      action.resultHash = learningHash(message.content ?? null);
    }
    if (message.role === "user") feedbackHash = learningHash(message.content ?? null);
  }
  return {
    framework: "hermes",
    environment: {},
    outcomeProvenance: "external-export-without-trusted-checker",
    taskId,
    skillVersion,
    sourceHash: sha256(input),
    evidence: "unverified",
    actions,
    feedbackHash,
    costs: null,
  };
}
export const hermesTraceAdapter: SkillTraceAdapter = {
  framework: "hermes",
  normalize(input, context) {
    const trace = importHermesTrace(input, context.taskId, context.skillVersion);
    const environment = z
      .record(z.string().max(200), z.string().max(200))
      .parse(context.environment ?? {});
    if (Object.keys(environment).length > 32) throw new Error("Trace environment too large");
    return { ...trace, environment };
  },
};
