import type { GatewayRequestHandlers } from "./types.js";
import { getModelRefStatus, resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "../../commands/models/shared.js";
import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
  validateModelsSetDefaultParams,
} from "../protocol/index.js";
import { refreshGatewayModelCatalog } from "../server-model-catalog.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      // refresh:true busts the process-lifetime catalog cache — required
      // after a key/provider write or new providers stay invisible until
      // the gateway restarts.
      const models =
        params.refresh === true
          ? await refreshGatewayModelCatalog()
          : await context.loadGatewayModelCatalog();
      // Annotate each entry with whether it may actually be selected under the
      // node's model policy, so the picker can hide models sessions.patch would
      // reject (they only diverge when restrictModels is on). Any failure here
      // is non-fatal — the list still returns, just unannotated.
      let annotated = models;
      try {
        const cfg = loadConfig();
        const def = resolveDefaultModelForAgent({ cfg });
        annotated = models.map((m) => ({
          ...m,
          allowed: getModelRefStatus({
            cfg,
            catalog: models,
            ref: { provider: m.provider, model: m.id },
            defaultProvider: def.provider,
            defaultModel: def.model,
          }).allowed,
        }));
      } catch {
        // leave models unannotated (older-gateway behavior: absent = allowed)
      }
      respond(true, { models: annotated }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.setDefault": async ({ params, respond }) => {
    if (!validateModelsSetDefaultParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.setDefault params: ${formatValidationErrors(validateModelsSetDefaultParams.errors)}`,
        ),
      );
      return;
    }
    try {
      // Same write path as `bitterbot models set`: resolves/validates the
      // ref (throws on unknown), sets agents.defaults.model.primary, and
      // ensures the model is allowlisted. The agents.* config prefix is
      // hot-by-construction, so this applies on the next turn, no restart.
      const updated = await updateConfig((cfg) =>
        applyDefaultModelPrimaryUpdate({ cfg, modelRaw: params.model, field: "model" }),
      );
      const primary = updated.agents?.defaults?.model;
      respond(
        true,
        {
          ok: true,
          model: typeof primary === "string" ? primary : (primary?.primary ?? params.model),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
