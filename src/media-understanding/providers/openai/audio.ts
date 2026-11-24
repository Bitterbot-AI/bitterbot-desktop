import path from "node:path";
import { USAGE_FEATURES } from "../../../infra/usage-features.js";
import { recordUsage } from "../../../infra/usage-ledger.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
// OpenAI retires whisper-1, gpt-4o-transcribe and gpt-4o-mini-transcribe on 2027-02-26;
// gpt-transcribe is the documented replacement on this endpoint and takes the same fields.
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-transcribe";

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
    // PLAN-50 Phase 5: token-billed models report token usage. Duration-billed models
    // (gpt-transcribe, whisper) report `{type: "duration", seconds}`; those rows store SECONDS
    // in `input` and are priced per second (AUDIO_PRICES_PER_MILLION_SECONDS). No usage at all
    // is recorded as one billable item and stays unpriced.
    const seconds =
      payload.usage?.type === "duration" &&
      typeof payload.usage.seconds === "number" &&
      Number.isFinite(payload.usage.seconds) &&
      payload.usage.seconds >= 0
        ? payload.usage.seconds
        : undefined;
    recordUsage({
      kind: "audio",
      feature: USAGE_FEATURES.mediaAudio,
      provider: /groq/i.test(baseUrl) ? "groq" : "openai",
      model,
      usage:
        seconds !== undefined
          ? { input: seconds, total: seconds }
          : {
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
