import { z } from "zod";

const XPolicySchema = z.strictObject({
  maxPostsPerDay: z.number().int().min(0).max(50).optional(),
  minIntervalMinutes: z.number().int().min(0).optional(),
  allowLinks: z.boolean().optional(),
  allowMentions: z.boolean().optional(),
  allowReplies: z.boolean().optional(),
  dedupeWindowDays: z.number().int().min(1).max(365).optional(),
  dedupeSimilarity: z.number().min(0).max(1).optional(),
});

const accountShape = {
  /** OAuth 2.0 client id from the X developer console (public). */
  clientId: z.string().min(1),
  /** OAuth 2.0 client secret (only for confidential "Automated App / Bot" apps). */
  clientSecret: z.string().optional(),
  /** Bot account handle, with or without the @. */
  handle: z
    .string()
    .regex(/^@?[A-Za-z0-9_]{1,15}$/, "handle must be 1-15 letters, digits or underscores")
    .optional(),
  tokenFile: z.string().optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
  enabled: z.boolean().optional(),
  policy: XPolicySchema.optional(),
};

const baseShape = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
};

const XAccountSchema = z.strictObject(accountShape);

/** Single-account form: account fields at the top level create the implicit "default" account. */
const SimplifiedSchema = z.strictObject({ ...baseShape, ...accountShape });

/** Multi-account form. */
const MultiAccountSchema = z
  .strictObject({
    ...baseShape,
    accounts: z.record(z.string(), XAccountSchema),
  })
  .refine((val) => Object.keys(val.accounts || {}).length > 0, {
    message: "accounts must contain at least one entry",
  });

export const XConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
export type XConfig = z.infer<typeof XConfigSchema>;
