import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const PresenceEntrySchema = Type.Object(
  {
    host: Type.Optional(NonEmptyString),
    ip: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    mode: Type.Optional(NonEmptyString),
    lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    reason: Type.Optional(NonEmptyString),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    text: Type.Optional(Type.String()),
    ts: Type.Integer({ minimum: 0 }),
    deviceId: Type.Optional(NonEmptyString),
    roles: Type.Optional(Type.Array(NonEmptyString)),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    instanceId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const HealthSnapshotSchema = Type.Any();

export const SessionDefaultsSchema = Type.Object(
  {
    defaultAgentId: NonEmptyString,
    mainKey: NonEmptyString,
    mainSessionKey: NonEmptyString,
    scope: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const StateVersionSchema = Type.Object(
  {
    presence: Type.Integer({ minimum: 0 }),
    health: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * What the gateway process itself is: the real package version (the same
 * one the Control UI footer is built with), process uptime, and where it
 * runs. Reported in the hello snapshot and in the `status` RPC so the
 * Overview cards do not have to guess.
 */
export const GatewayRuntimeSchema = Type.Object(
  {
    version: NonEmptyString,
    uptimeMs: Type.Integer({ minimum: 0 }),
    /** `process.platform` (linux, darwin, win32, ...). */
    platform: NonEmptyString,
    /** `process.arch` (x64, arm64, ...). */
    arch: NonEmptyString,
    nodeVersion: Type.Optional(NonEmptyString),
    installKind: Type.Optional(
      Type.Union([
        Type.Literal("git"),
        Type.Literal("package"),
        Type.Literal("container"),
        Type.Literal("tarball"),
        Type.Literal("unknown"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const SnapshotSchema = Type.Object(
  {
    presence: Type.Array(PresenceEntrySchema),
    health: HealthSnapshotSchema,
    stateVersion: StateVersionSchema,
    uptimeMs: Type.Integer({ minimum: 0 }),
    runtime: Type.Optional(GatewayRuntimeSchema),
    configPath: Type.Optional(NonEmptyString),
    stateDir: Type.Optional(NonEmptyString),
    sessionDefaults: Type.Optional(SessionDefaultsSchema),
    authMode: Type.Optional(
      Type.Union([
        Type.Literal("none"),
        Type.Literal("token"),
        Type.Literal("password"),
        Type.Literal("trusted-proxy"),
      ]),
    ),
  },
  { additionalProperties: false },
);
