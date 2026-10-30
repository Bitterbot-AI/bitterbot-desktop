import { z } from "zod";

export const TEACHING_DURATION_MS = 10 * 60_000;
export const TEACHING_MAX_ACTIONS = 300;
export const TEACHING_MAX_RECORDINGS = 50;

export const teachingDetailsSchema = z
  .object({
    title: z.string().trim().min(3).max(100),
    goal: z.string().trim().min(5).max(500),
    outcome: z.string().trim().min(5).max(500),
  })
  .strict();
export type TeachingDetails = z.infer<typeof teachingDetailsSchema>;

export const teachingActionSchema = z
  .object({
    kind: z.enum(["click", "type", "key", "scroll", "manual"]),
    url: z
      .string()
      .max(2000)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    role: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    sensitive: z.boolean(),
    key: z
      .enum([
        "Enter",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ])
      .optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
  })
  .strict();
export type TeachingAction = z.infer<typeof teachingActionSchema>;

export const teachingDraftOptionsSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    description: z.string().trim().min(40).max(240),
    parameters: z
      .record(z.string().regex(/^input_[1-9][0-9]*$/), z.string().regex(/^[a-z][a-z0-9_]{1,39}$/))
      .default({}),
  })
  .strict();
export type TeachingDraftOptions = z.infer<typeof teachingDraftOptionsSchema>;

export const teachingRecordSchema = teachingDetailsSchema
  .extend({
    id: z.string().uuid(),
    profile: z.string().min(1).max(100),
    createdAt: z.number(),
    stoppedAt: z.number().optional(),
    status: z.enum(["recording", "stopped", "failed", "staged", "saved"]),
    reason: z.string().max(200).optional(),
    actions: z.array(teachingActionSchema).max(TEACHING_MAX_ACTIONS),
    skillName: z.string().max(64).optional(),
    draftOptions: teachingDraftOptionsSchema.optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type TeachingRecord = z.infer<typeof teachingRecordSchema>;
