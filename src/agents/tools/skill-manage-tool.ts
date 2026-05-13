/**
 * Agent tool: skill_manage.
 *
 * Closes PLAN-15's "LLM-callable wrapper" follow-up. Lets the agent stage
 * its own skill mutations behind the SICA staging-gate without going through
 * the desktop UI. Every mutation lands in staging first; the behavioural
 * gate runs synchronously; on pass, the agent can call `skill_promote` to
 * lift to live. There is no auto-promote path here — staging review is the
 * point.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { withSkillLifecycleStore } from "../skills/skill-lifecycle-from-config.js";
import {
  skillManage,
  type SkillManageAction,
  type SkillManageParams,
} from "../skills/skill-manage.js";
import { promoteStaged, rollbackStaged } from "../skills/skill-promote.js";
import { resolveStorageRoots } from "../skills/skill-storage.js";
import { jsonResult, readStringParam } from "./common.js";

const ManageSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("edit"),
      Type.Literal("patch"),
      Type.Literal("delete"),
      Type.Literal("consolidate"),
      Type.Literal("promote"),
      Type.Literal("rollback"),
    ],
    {
      description:
        "What to do with the named skill. create/edit/patch/delete/consolidate stage a " +
        "mutation behind the behavioural gate. promote moves passed staged content to live. " +
        "rollback restores an archived version.",
    },
  ),
  name: Type.String({
    description:
      "Skill name (matches the SKILL.md directory). Lowercase letters, digits, dots, " +
      "dashes, underscores; up to 64 characters.",
    minLength: 1,
    maxLength: 64,
  }),
  reason: Type.String({
    description: "Short explanation of why you're making this change. Recorded in staging meta.",
    minLength: 1,
    maxLength: 500,
  }),
  /** create/edit only — full SKILL.md content including frontmatter. */
  content: Type.Optional(
    Type.String({
      description:
        "For create/edit only. Full SKILL.md content starting with --- frontmatter. " +
        "Required fields: name, description. Body must be non-empty.",
    }),
  ),
  /** patch only — substring to find. */
  oldString: Type.Optional(
    Type.String({
      description:
        "For patch only. Exact substring to replace in the live SKILL.md. Must match " +
        "exactly once unless replaceAll is true.",
    }),
  ),
  /** patch only — replacement substring. */
  newString: Type.Optional(
    Type.String({
      description: "For patch only. The replacement substring. May be empty (deletes the match).",
    }),
  ),
  /** patch only — replace every occurrence. */
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        "For patch only. Replace every occurrence of oldString. Default false (single-match, " +
        "errors with patch-ambiguous when oldString appears more than once).",
    }),
  ),
  /** delete only — optional note recorded in the tombstone. */
  note: Type.Optional(
    Type.String({
      description: "For delete only. Optional note recorded in the tombstone manifest.",
    }),
  ),
  /** consolidate only — target skill to merge into. */
  into: Type.Optional(
    Type.String({
      description:
        "For consolidate only. Existing live skill name to merge this skill into. The " +
        "named skill is archived in favour of `into`.",
    }),
  ),
  /** edit/patch only — override the regression gate. */
  acceptHighRiskDiff: Type.Optional(
    Type.Boolean({
      description:
        "For edit/patch only. Override the regression gate when the live skill has high " +
        "empirical success and the staged diff is large. Use sparingly.",
    }),
  ),
  /** create only — replace an existing live skill of the same name. */
  overwriteLive: Type.Optional(
    Type.Boolean({
      description:
        "For create only. Permit clobbering an existing live skill with the same name. " +
        "Default false (use action=edit instead when a live skill exists).",
    }),
  ),
  /** promote only — promote even on a failed gate. Operator-only override. */
  forceGate: Type.Optional(
    Type.Boolean({
      description:
        "For promote only. Promote even when the staging gate did not pass. Avoid unless " +
        "you've reviewed the gate failure reason and it's a known false positive.",
    }),
  ),
  /** rollback only — version number from the archive. */
  version: Type.Optional(
    Type.Integer({
      description: "For rollback only. The archived version number to restore (see archive list).",
      minimum: 1,
    }),
  ),
});

export function createSkillManageTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Manage Skills",
    name: "skill_manage",
    description:
      "Stage, gate, promote, or rollback a SKILL.md mutation. Use this when the user asks " +
      "you to add / change / remove a skill or when telemetry suggests an existing skill is " +
      "broken. Workflow: action=create|edit|patch|delete|consolidate stages a change behind " +
      "the behavioural gate; if the response includes ok:true and gateOutcome ∈ {pass, warn} " +
      "you can then call action=promote with the same name to lift staged → live. Use " +
      "action=rollback + version=N to restore an archived version. Never promote a 'fail' " +
      "outcome without forceGate=true and a documented reason.",
    parameters: ManageSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action") as
        | SkillManageAction
        | "promote"
        | "rollback";
      const name = readStringParam(params, "name");
      const reason = readStringParam(params, "reason") ?? "(no reason provided)";
      if (!name) {
        return jsonResult({ ok: false, error: "name required" });
      }
      const roots = resolveStorageRoots();
      const author = `agent:${agentId}`;

      try {
        if (action === "promote") {
          const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
            promoteStaged(
              { storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) },
              {
                name,
                reason,
                author,
                ...(params.forceGate ? { forceGate: true } : {}),
              },
            ),
          );
          return jsonResult({
            ok: result.ok,
            action: "promote",
            name,
            kind: result.kind,
            previousArchivedVersion: result.previousArchived?.version,
            error: result.error,
            detail: result.detail,
          });
        }

        if (action === "rollback") {
          const version = readNumber(params, "version");
          if (!version) {
            return jsonResult({ ok: false, error: "version required for rollback" });
          }
          const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
            rollbackStaged(
              { storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) },
              { name, version, reason, author },
            ),
          );
          return jsonResult({
            ok: result.ok,
            action: "rollback",
            name,
            previousArchivedVersion: result.previousArchived?.version,
            error: result.error,
            detail: result.detail,
          });
        }

        const manageParams = buildManageParams({ params, action, name, reason, author });
        if (!manageParams.ok) {
          return jsonResult({ ok: false, error: manageParams.error });
        }
        const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
          skillManage(
            { storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) },
            manageParams.value,
          ),
        );
        return jsonResult({
          ok: result.ok,
          action,
          name: result.name,
          stagedFilePath: result.stagedFilePath,
          gateOutcome: result.gate?.outcome,
          gateSummary: result.gateSummary,
          gateIssues: result.gate?.issues,
          baselineRuns: result.gate?.baselineRuns,
          baselineSuccessRate: result.gate?.baselineSuccessRate,
          error: result.error,
          detail: result.detail,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          action,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}

function buildManageParams(args: {
  params: Record<string, unknown>;
  action: SkillManageAction;
  name: string;
  reason: string;
  author: string;
}): { ok: true; value: SkillManageParams } | { ok: false; error: string } {
  const { params, action, name, reason, author } = args;
  switch (action) {
    case "create": {
      const content = readStringParam(params, "content");
      if (!content) {
        return { ok: false, error: "content required for create" };
      }
      return {
        ok: true,
        value: {
          action: "create",
          name,
          content,
          reason,
          author,
          ...(params.overwriteLive === true ? { overwriteLive: true } : {}),
        },
      };
    }
    case "edit": {
      const content = readStringParam(params, "content");
      if (!content) {
        return { ok: false, error: "content required for edit" };
      }
      return {
        ok: true,
        value: {
          action: "edit",
          name,
          content,
          reason,
          author,
          ...(params.acceptHighRiskDiff === true ? { acceptHighRiskDiff: true } : {}),
        },
      };
    }
    case "patch": {
      const oldString = readStringParam(params, "oldString");
      const newString = typeof params.newString === "string" ? params.newString : "";
      if (!oldString) {
        return { ok: false, error: "oldString required for patch" };
      }
      return {
        ok: true,
        value: {
          action: "patch",
          name,
          oldString,
          newString,
          reason,
          author,
          ...(params.replaceAll === true ? { replaceAll: true } : {}),
          ...(params.acceptHighRiskDiff === true ? { acceptHighRiskDiff: true } : {}),
        },
      };
    }
    case "delete": {
      const note = readStringParam(params, "note");
      return {
        ok: true,
        value: {
          action: "delete",
          name,
          reason,
          author,
          ...(note ? { note } : {}),
        },
      };
    }
    case "consolidate": {
      const into = readStringParam(params, "into");
      if (!into) {
        return { ok: false, error: "into required for consolidate" };
      }
      return {
        ok: true,
        value: {
          action: "consolidate",
          name,
          into,
          reason,
          author,
        },
      };
    }
  }
}
