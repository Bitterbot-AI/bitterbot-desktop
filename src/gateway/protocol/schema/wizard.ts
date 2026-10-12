import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

export const WizardStartParamsSchema = Type.Object(
  {
    mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
    workspace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardAnswerSchema = Type.Object(
  {
    stepId: NonEmptyString,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const WizardNextParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    answer: Type.Optional(WizardAnswerSchema),
  },
  { additionalProperties: false },
);

export const WizardCancelParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardStatusParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardStepOptionSchema = Type.Object(
  {
    value: Type.Unknown(),
    label: NonEmptyString,
    hint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardSectionSchema = Type.Object(
  {
    id: NonEmptyString,
    title: NonEmptyString,
    index: Type.Integer({ minimum: 1 }),
    total: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const WizardStepSchema = Type.Object(
  {
    id: NonEmptyString,
    type: Type.Union([
      Type.Literal("note"),
      Type.Literal("select"),
      Type.Literal("text"),
      Type.Literal("confirm"),
      Type.Literal("multiselect"),
      Type.Literal("progress"),
      Type.Literal("action"),
    ]),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    initialValue: Type.Optional(Type.Unknown()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
    // PLAN-56 Phase 4: which setup step (src/wizard/setup-steps.ts) this
    // prompt belongs to, so a renderer can show progress.
    section: Type.Optional(WizardSectionSchema),
    // Structured detail a renderer may show richly (first reply, doctor
    // summary, completion). Never carries a secret.
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const WizardNextResultSchema = Type.Object(
  {
    done: Type.Boolean(),
    step: Type.Optional(WizardStepSchema),
    status: Type.Optional(WizardRunStatusSchema),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardStartResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    done: Type.Boolean(),
    step: Type.Optional(WizardStepSchema),
    status: Type.Optional(WizardRunStatusSchema),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardStatusResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("cancelled"),
      Type.Literal("error"),
    ]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
