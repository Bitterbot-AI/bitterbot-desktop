import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { USAGE_FEATURES } from "../../../infra/usage-features.js";
import { recordUsage } from "../../../infra/usage-ledger.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_OPENAI_AUDIO_MODEL;
}

export async function transcribeOpenAiCompatibleAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENAI_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model);
  const transcribeStartedAt = Date.now();
  const form = new FormData();
  const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers,
      body: form,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as {
      text?: string;
      usage?: {
        type?: string;
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        seconds?: number;
      };
    };
    const text = payload.text?.trim();
    if (!text) {
      throw new Error("Audio transcription response missing text");
    }
    // PLAN-50 Phase 5: gpt-4o-transcribe reports token usage; whisper reports nothing (or
    // seconds), in which case the call is recorded as one billable item and stays unpriced.
    recordUsage({
      kind: "audio",
      feature: USAGE_FEATURES.mediaAudio,
      provider: /groq/i.test(baseUrl) ? "groq" : "openai",
      model,
      usage: {
        input: payload.usage?.input_tokens,
        output: payload.usage?.output_tokens,
        total: payload.usage?.total_tokens,
      },
      items: 1,
      durationMs: Date.now() - transcribeStartedAt,
    });
    return { text, model };
  } finally {
    await release();
  }
}
