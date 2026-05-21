import type { Api, Model } from "@mariozechner/pi-ai";
import { mergeNearAiCompat, NEARAI_BASE_URL } from "./nearai-models.js";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const isNearAi = model.provider === "nearai" || baseUrl.includes(NEARAI_BASE_URL);
  if (isNearAi && isOpenAiCompletionsModel(model)) {
    const openaiModel = model;
    openaiModel.compat = mergeNearAiCompat(openaiModel.compat ?? undefined);
    return openaiModel;
  }

  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(model)) {
    return model;
  }

  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return model;
  }

  openaiModel.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return openaiModel;
}
