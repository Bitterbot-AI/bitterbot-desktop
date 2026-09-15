import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type { ImageDescriptionRequest, ImageDescriptionResult } from "../types.js";
import { minimaxUnderstandImage } from "../../agents/minimax-vlm.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { ensureBitterbotModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import { coerceImageAssistantText } from "../../agents/tools/image-tool.helpers.js";
import { USAGE_FEATURES } from "../../infra/usage-features.js";
import { recordUsage } from "../../infra/usage-ledger.js";

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  await ensureBitterbotModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const model = modelRegistry.find(params.provider, params.model) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }
  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);
  authStorage.setRuntimeApiKey(model.provider, apiKey);

  const base64 = params.buffer.toString("base64");
  if (model.provider === "minimax") {
    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: params.prompt ?? "Describe the image.",
      imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${base64}`,
      modelBaseUrl: model.baseUrl,
    });
    return { text, model: model.id };
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt ?? "Describe the image." },
          { type: "image", data: base64, mimeType: params.mime ?? "image/jpeg" },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const startedAt = Date.now();
  const message = await complete(model, context, {
    apiKey,
    maxTokens: params.maxTokens ?? 512,
  });
  // PLAN-50: vision calls land in the usage ledger under media/image.
  recordUsage({
    kind: "vision",
    feature: USAGE_FEATURES.mediaImage,
    provider: message.provider ?? model.provider,
    model: message.model ?? model.id,
    api: message.api,
    usage: message.usage,
    cost: message.usage?.cost,
    durationMs: Date.now() - startedAt,
    status: message.stopReason === "error" ? "error" : "ok",
    stopReason: message.stopReason,
    config: params.cfg,
  });
  const text = coerceImageAssistantText({
    message,
    provider: model.provider,
    model: model.id,
  });
  return { text, model: model.id };
}
