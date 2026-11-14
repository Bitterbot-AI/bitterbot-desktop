import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { BitterbotConfig } from "../../config/config.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  HashSchema,
  RequirementsSchema,
  packageHash,
  sha256,
} from "../skills/collective/contracts.js";
import { releaseLocalPackage } from "../skills/collective/local.js";
import { validateManifest, screenPackage } from "../skills/collective/package.js";
import { getCollectiveRuntime } from "../skills/collective/runtime.js";
import { queuePackageOperation } from "../skills/collective/service.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import { jsonResult, type AnyAgentTool } from "./common.js";

export function createSkillPackageTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg?.skills?.collective?.enabled) return null;
  return {
    name: "skill_package",
    label: "Skill Packages",
    description:
      "Propose a complete package, inspect qualification, or request evaluation/adoption already covered by operator grants. Propose payload: {files: {relativePath: text}, requirements: {platforms, tools, capabilities, runtime}}. Include SKILL.md with name and description frontmatter. No grants, self-certification, setup authorization, or policy changes are available. Generated briefs still require ordinary draft review before posting.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("propose"),
        Type.Literal("evaluate"),
        Type.Literal("adopt"),
      ]),
      payload: Type.Optional(Type.String({ maxLength: 100000 })),
      releaseId: Type.Optional(Type.String()),
    }),
    execute: async (_id, raw) => {
      const params = z
        .object({
          action: z.enum(["status", "propose", "evaluate", "adopt"]),
          payload: z.string().max(100000).optional(),
          releaseId: HashSchema.optional(),
        })
        .strict()
        .parse(raw);
      const runtime = getCollectiveRuntime(cfg)!;
      const agent = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });
      if (params.action === "status")
        return jsonResult({
          packages: runtime.store.list().map((p) => ({
            hash: p.hash,
            name: p.manifest.name,
            state: p.state,
            reason: p.reason,
          })),
        });
      if (params.action === "propose") {
        const proposal = z
          .object({ files: z.record(z.string(), z.string()), requirements: RequirementsSchema })
          .strict()
          .parse(JSON.parse(params.payload ?? "{}"));
        const files = new Map(
          Object.entries(proposal.files).map(([name, bytes]) => [name, Buffer.from(bytes)]),
        );
        const metadata = parseFrontmatter(files.get("SKILL.md")?.toString("utf8") ?? "");
        const manifest = validateManifest({
          schemaVersion: 1,
          name: metadata.name,
          description: metadata.description,
          entrypoint: "SKILL.md",
          requirements: proposal.requirements,
          files: [...files]
            .map(([name, bytes]) => ({
              path: name,
              size: bytes.length,
              hash: sha256(bytes),
              executable: false,
            }))
            .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        });
        const snapshot = { manifest, files, packageHash: packageHash(manifest), omitted: [] };
        screenPackage(snapshot);
        await runtime.store.install(snapshot);
        return jsonResult({
          packageHash: snapshot.packageHash,
          releaseId: releaseLocalPackage(runtime.store, snapshot.packageHash, manifest.name),
          state: "candidate",
        });
      }
      const release = runtime.store.release(params.releaseId ?? "");
      if (!release) throw new Error("Unknown release");
      // Agent-originated requests always need a grant, including local proposals.
      runtime.policies.authorize(
        agent,
        release,
        params.action === "adopt" ? "adopt" : "evaluate",
        "skill-package",
      );
      return jsonResult({
        jobId: queuePackageOperation(
          runtime,
          agent,
          params.releaseId!,
          params.action === "adopt" ? "adopt" : "validate",
        ),
      });
    },
  };
}
