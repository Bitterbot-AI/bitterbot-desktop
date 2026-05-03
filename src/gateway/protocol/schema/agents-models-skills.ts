import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);

export const SkillsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    content: NonEmptyString,
    /** Where to write the skill: "managed" (~/.bitterbot/skills) or "workspace". */
    target: Type.Optional(Type.Union([Type.Literal("managed"), Type.Literal("workspace")])),
    /** Optional agent ID; only used when target = "workspace". */
    agentId: Type.Optional(NonEmptyString),
    /** Refuse to overwrite an existing skill at the same path. */
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * Per-skill execution telemetry. Aggregated from skill_executions
 * by SkillExecutionTracker.getSkillMetrics.
 */
export const SkillsMetricsParamsSchema = Type.Object(
  {
    /** Optional: pass a specific skillKey (skill name) to fetch one. Omit for all skills. */
    skillKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillMetricsEntrySchema = Type.Object(
  {
    skillKey: NonEmptyString,
    totalExecutions: Type.Integer({ minimum: 0 }),
    successRate: Type.Number({ minimum: 0, maximum: 1 }),
    avgRewardScore: Type.Number(),
    avgExecutionTimeMs: Type.Number({ minimum: 0 }),
    userFeedbackScore: Type.Number(),
    lastExecutedAt: Type.Integer({ minimum: 0 }),
    errorBreakdown: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SkillsMetricsResultSchema = Type.Object(
  {
    metrics: Type.Array(SkillMetricsEntrySchema),
  },
  { additionalProperties: false },
);

/**
 * Per-agent skill allowlist mutation. Mirrors AgentConfig.skills:
 * undefined / omitted => all skills allowed, [] => none, [...keys] => allowlist.
 */
export const SkillsUpdateAgentFilterParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    /** New allowlist, or null to clear (i.e. allow all). */
    skills: Type.Union([Type.Array(NonEmptyString), Type.Null()]),
  },
  { additionalProperties: false },
);

export const SkillsUpdateAgentFilterResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    skills: Type.Union([Type.Array(NonEmptyString), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * Trust-related skill config (P2P ingest + agentskills.io bridge).
 * Writes via the same path as skills.update — bump snapshot, no restart.
 */
export const SkillsUpdateTrustSettingsParamsSchema = Type.Object(
  {
    p2p: Type.Optional(
      Type.Object(
        {
          ingestPolicy: Type.Optional(
            Type.Union([Type.Literal("auto"), Type.Literal("review"), Type.Literal("deny")]),
          ),
          maxIngestedPerHour: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
          injectionScanner: Type.Optional(Type.Union([Type.Literal("regex"), Type.Literal("off")])),
          quarantineTtlDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
        },
        { additionalProperties: false },
      ),
    ),
    agentskills: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          defaultTrust: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("review")])),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SkillsUpdateTrustSettingsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    p2p: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    agentskills: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/**
 * Sandbox-style validation: runs frontmatter parse, the prompt-injection
 * scanner, and OS/bin compat checks on raw SKILL.md content. No persistence.
 */
export const SkillsValidateParamsSchema = Type.Object(
  {
    content: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillValidationDiagnosticSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info")]),
    code: NonEmptyString,
    message: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsValidateResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    frontmatter: Type.Object(
      {
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        primaryEnv: Type.Optional(Type.String()),
        os: Type.Optional(Type.Array(Type.String())),
        requires: Type.Optional(
          Type.Object(
            {
              bins: Type.Optional(Type.Array(Type.String())),
              env: Type.Optional(Type.Array(Type.String())),
            },
            { additionalProperties: true },
          ),
        ),
      },
      { additionalProperties: true },
    ),
    injectionScan: Type.Object(
      {
        severity: Type.Union([
          Type.Literal("ok"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("critical"),
        ]),
        flags: Type.Array(Type.String()),
        weight: Type.Number(),
        reason: Type.String(),
      },
      { additionalProperties: false },
    ),
    diagnostics: Type.Array(SkillValidationDiagnosticSchema),
  },
  { additionalProperties: false },
);

/**
 * Sign-and-publish over the P2P skill gossipsub topic.
 * The orchestrator does the signing using the local node identity key.
 */
export const SkillsPublishParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    content: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsPublishResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    /** Skill content hash (sha256 hex) used as the version key. */
    contentHash: Type.Optional(NonEmptyString),
    /** Estimated number of peers that received the message. */
    deliveredTo: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Upload a SKILL.md to agentskills.io. Requires `skills.agentskills.enabled`
 * and an API key configured under `skills.agentskills.apiKey`.
 */
export const SkillsUploadAgentskillsParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    content: NonEmptyString,
    /** Optional human label; defaults to name. */
    title: Type.Optional(Type.String()),
    /** Visibility: 'public' (default) or 'unlisted'. */
    visibility: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("unlisted")])),
  },
  { additionalProperties: false },
);

export const SkillsUploadAgentskillsResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    slug: Type.Optional(NonEmptyString),
    upstreamUrl: Type.Optional(NonEmptyString),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
