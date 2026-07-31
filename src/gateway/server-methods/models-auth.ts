import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { probeProviderKey } from "../../agents/auth-probe.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store.js";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { buildTokenProfileId } from "../../commands/auth-token.js";
import { loadConfig } from "../../config/config.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsAuthDeleteParams,
  validateModelsAuthListParams,
  validateModelsAuthSetParams,
  validateModelsAuthTestParams,
} from "../protocol/index.js";
import { refreshGatewayModelCatalog } from "../server-model-catalog.js";

/**
 * models.auth.* — key management over RPC so the Control UI can list
 * credential status, test a key before saving, and save/rotate/delete
 * auth profiles without the CLI wizard.
 *
 * Contract: write-only secrets. Keys go in via models.auth.set/test;
 * nothing in any response ever contains a stored secret. This surface is
 * store-agnostic on purpose (PLAN-37 will re-home storage): everything
 * goes through the auth-profiles helpers, never at the file directly.
 */

type ProviderAuthStatus = {
  provider: string;
  profiles: Array<{
    profileId: string;
    type: AuthProfileCredential["type"];
    email?: string;
    inCooldown: boolean;
    disabledUntil?: number;
    errorCount?: number;
    lastUsed?: number;
  }>;
  /** True when a provider env var would supply a key. */
  envPresent: boolean;
  /** Label of the env source when present (e.g. "env: ANTHROPIC_API_KEY"). */
  envSource?: string;
  /** True when models.providers[provider].apiKey is set in config. */
  configKeyPresent: boolean;
  /**
   * Which source wins under the runtime precedence chain
   * (profile > env > config), mirroring resolveApiKeyForProvider order.
   */
  winningSource: string | null;
};

function summarizeProvider(params: {
  provider: string;
  store: AuthProfileStore;
  cfg: ReturnType<typeof loadConfig>;
  now: number;
}): ProviderAuthStatus {
  const { provider, store, cfg, now } = params;
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  const profiles = order
    .filter((id) => Boolean(store.profiles[id]))
    .map((profileId) => {
      const cred = store.profiles[profileId];
      const stats = store.usageStats?.[profileId];
      return {
        profileId,
        type: cred.type,
        email: cred.email,
        inCooldown: typeof stats?.cooldownUntil === "number" && stats.cooldownUntil > now,
        disabledUntil:
          typeof stats?.disabledUntil === "number" && stats.disabledUntil > now
            ? stats.disabledUntil
            : undefined,
        errorCount: stats?.errorCount,
        lastUsed: stats?.lastUsed,
      };
    });

  const env = resolveEnvApiKey(provider);
  const configKeyPresent = Boolean(cfg.models?.providers?.[provider]?.apiKey?.trim());

  // Structural mirror of resolveApiKeyForProvider precedence — reported so
  // the UI can explain "which source is winning" (the documented
  // bad-profile-shadows-good-env trap becomes visible instead of silent).
  const winningSource =
    profiles.length > 0
      ? `profile:${profiles[0].profileId}`
      : env
        ? env.source
        : configKeyPresent
          ? "models.json"
          : null;

  return {
    provider,
    profiles,
    envPresent: Boolean(env),
    envSource: env?.source,
    configKeyPresent,
    winningSource,
  };
}

export const modelsAuthHandlers: GatewayRequestHandlers = {
  "models.auth.list": async ({ params, respond, context }) => {
    if (!validateModelsAuthListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.list params: ${formatValidationErrors(validateModelsAuthListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const store = ensureAuthProfileStore();
      const catalog = await context.loadGatewayModelCatalog();
      const providers = new Set<string>();
      for (const entry of catalog) {
        providers.add(normalizeProviderId(entry.provider));
      }
      for (const cred of Object.values(store.profiles)) {
        providers.add(normalizeProviderId(cred.provider));
      }
      for (const id of Object.keys(cfg.models?.providers ?? {})) {
        providers.add(normalizeProviderId(id));
      }
      const now = Date.now();
      const result = [...providers]
        .toSorted((a, b) => a.localeCompare(b))
        .map((provider) => summarizeProvider({ provider, store, cfg, now }));
      respond(true, { providers: result }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "models.auth.test": async ({ params, respond }) => {
    if (!validateModelsAuthTestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.test params: ${formatValidationErrors(validateModelsAuthTestParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const provider = normalizeProviderId(params.provider);
      let apiKey = normalizeSecretInput(params.apiKey ?? "");
      if (!apiKey) {
        // Write-only contract: a stored credential may only be probed
        // against its own configured endpoint. Combining a stored key with
        // a caller-supplied baseUrl would send the secret to an arbitrary
        // host - that is credential exfiltration, not a test.
        if (params.baseUrl?.trim()) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "baseUrl requires a draft apiKey; stored credentials only probe their configured endpoint",
            ),
          );
          return;
        }
        // No draft key: probe whatever credential currently wins for the
        // provider (or the named profile). OAuth-backed credentials resolve
        // to a bearer token that the probe can't exercise meaningfully.
        const resolved = await resolveApiKeyForProvider({
          provider,
          cfg,
          profileId: params.profileId,
        });
        if (resolved.mode === "oauth" || resolved.mode === "aws-sdk") {
          respond(
            true,
            {
              result: {
                ok: false,
                unsupported: true,
                error: `Stored credential is ${resolved.mode}; live probing supports API keys and tokens only.`,
              },
              source: resolved.source,
            },
            undefined,
          );
          return;
        }
        apiKey = resolved.apiKey ?? "";
      }
      const result = await probeProviderKey({
        provider,
        apiKey,
        cfg,
        baseUrl: params.baseUrl,
      });
      respond(true, { result }, undefined);
    } catch (err) {
      // A missing credential is a legitimate probe outcome, not a transport error.
      respond(
        true,
        { result: { ok: false, error: err instanceof Error ? err.message : String(err) } },
        undefined,
      );
    }
  },

  "models.auth.set": async ({ params, respond }) => {
    if (!validateModelsAuthSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.set params: ${formatValidationErrors(validateModelsAuthSetParams.errors)}`,
        ),
      );
      return;
    }
    const provider = normalizeProviderId(params.provider);
    // Normalize BEFORE the lock write: upsertAuthProfileWithLock stores the
    // credential verbatim, so un-normalized input would persist as-is.
    const value = normalizeSecretInput(params.value);
    if (!value) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "empty credential"));
      return;
    }
    const profileId = buildTokenProfileId({ provider, name: params.name ?? "" });
    const credential: AuthProfileCredential =
      params.credentialType === "token"
        ? { type: "token", provider, token: value }
        : { type: "api_key", provider, key: value };

    const updated = await updateAuthProfileStoreWithLock({
      updater: (store) => {
        store.profiles[profileId] = credential;
        // Key rotation must clear prior cooldown/failure state or the fresh
        // key inherits the dead key's penalty box (PLAN-37 H2).
        if (store.usageStats?.[profileId]) {
          delete store.usageStats[profileId];
        }
        return true;
      },
    });
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "auth store update failed"));
      return;
    }
    // When an explicit rotation order exists (store.order, cfg.auth.order,
    // or cfg.auth.profiles), resolveAuthProfileOrder drops any profile not
    // in it - a freshly saved key would be silently dead: never used at
    // runtime and invisible in models.auth.list. Append it to a stored
    // order (stored order takes precedence over config order).
    const effectiveOrder = resolveAuthProfileOrder({
      cfg: loadConfig(),
      store: updated,
      provider,
    });
    if (!effectiveOrder.includes(profileId)) {
      await updateAuthProfileStoreWithLock({
        updater: (store) => {
          store.order = store.order ?? {};
          const existingKey =
            Object.keys(store.order).find((key) => normalizeProviderId(key) === provider) ??
            provider;
          const base = store.order[existingKey] ?? effectiveOrder;
          store.order[existingKey] = [...base.filter((id) => id !== profileId), profileId];
          return true;
        },
      });
    }
    // New credentials can surface new providers/models; stale cache would
    // hide them from every picker until restart.
    try {
      await refreshGatewayModelCatalog();
    } catch {
      // Catalog refresh failure is non-fatal; next models.list {refresh} retries.
    }
    respond(true, { ok: true, profileId }, undefined);
  },

  "models.auth.delete": async ({ params, respond }) => {
    if (!validateModelsAuthDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.delete params: ${formatValidationErrors(validateModelsAuthDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const profileId = params.profileId;
    let found = false;
    const updated = await updateAuthProfileStoreWithLock({
      updater: (store) => {
        if (!store.profiles[profileId]) {
          return false;
        }
        found = true;
        delete store.profiles[profileId];
        if (store.usageStats?.[profileId]) {
          delete store.usageStats[profileId];
        }
        if (store.order) {
          for (const [provider, order] of Object.entries(store.order)) {
            const next = order.filter((id) => id !== profileId);
            if (next.length !== order.length) {
              if (next.length === 0) {
                delete store.order[provider];
              } else {
                store.order[provider] = next;
              }
            }
          }
          if (Object.keys(store.order).length === 0) {
            store.order = undefined;
          }
        }
        if (store.lastGood) {
          for (const [provider, id] of Object.entries(store.lastGood)) {
            if (id === profileId) {
              delete store.lastGood[provider];
            }
          }
        }
        return true;
      },
    });
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "auth store update failed"));
      return;
    }
    if (!found) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown profile: ${profileId}`),
      );
      return;
    }
    try {
      await refreshGatewayModelCatalog();
    } catch {
      // Non-fatal; see models.auth.set.
    }
    respond(true, { ok: true }, undefined);
  },
};
