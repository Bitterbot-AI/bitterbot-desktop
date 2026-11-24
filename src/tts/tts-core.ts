import { rmSync } from "node:fs";
import type { TextContent } from "@mariozechner/pi-ai";
import { EdgeTTS } from "node-edge-tts";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import type { BitterbotConfig } from "../config/config.js";
import { USAGE_FEATURES } from "../infra/usage-features.js";
import { recordUsage } from "../infra/usage-ledger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  OPENAI_REALTIME_TTS_MODELS,
  isOpenAIRealtimeTtsModel,
  isOpenAIRealtimeTtsVoice,
  openaiRealtimeTTS,
  realtimeSpeechBudgetMs,
  resolveOpenAIRealtimeVoice,
} from "./openai-realtime-tts.js";
import type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./tts.js";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

function normalizeElevenLabsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function requireInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function assertElevenLabsVoiceSettings(settings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"]) {
  requireInRange(settings.stability, 0, 1, "stability");
  requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
  requireInRange(settings.style, 0, 1, "style");
  requireInRange(settings.speed, 0.5, 2, "speed");
}

function normalizeLanguageCode(code?: string): string | undefined {
  const trimmed = code?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error("languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)");
  }
  return normalized;
}

function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined {
  const trimmed = mode?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || normalized === "on" || normalized === "off") {
    return normalized;
  }
  throw new Error("applyTextNormalization must be one of: auto, on, off");
}

function normalizeSeed(seed?: number): number | undefined {
  if (seed == null) {
    return undefined;
  }
  const next = Math.floor(seed);
  if (!Number.isFinite(next) || next < 0 || next > 4_294_967_295) {
    throw new Error("seed must be between 0 and 4294967295");
  }
  return next;
}

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseNumberValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTtsDirectives(
  text: string,
  policy: ResolvedTtsModelOverrides,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body: string) => {
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = rawKey.toLowerCase();
      try {
        switch (key) {
          case "provider":
            if (!policy.allowProvider) {
              break;
            }
            if (rawValue === "openai" || rawValue === "elevenlabs" || rawValue === "edge") {
              overrides.provider = rawValue;
            } else {
              warnings.push(`unsupported provider "${rawValue}"`);
            }
            break;
          case "voice":
          case "openai_voice":
          case "openaivoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidOpenAIVoice(rawValue)) {
              overrides.openai = { ...overrides.openai, voice: rawValue };
            } else {
              warnings.push(`invalid OpenAI voice "${rawValue}"`);
            }
            break;
          case "voiceid":
          case "voice_id":
          case "elevenlabs_voice":
          case "elevenlabsvoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidVoiceId(rawValue)) {
              overrides.elevenlabs = { ...overrides.elevenlabs, voiceId: rawValue };
            } else {
              warnings.push(`invalid ElevenLabs voiceId "${rawValue}"`);
            }
            break;
          case "model":
          case "modelid":
          case "model_id":
          case "elevenlabs_model":
          case "elevenlabsmodel":
          case "openai_model":
          case "openaimodel":
            if (!policy.allowModelId) {
              break;
            }
            if (isValidOpenAIModel(rawValue)) {
              overrides.openai = { ...overrides.openai, model: rawValue };
            } else {
              overrides.elevenlabs = { ...overrides.elevenlabs, modelId: rawValue };
            }
            break;
          case "stability":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid stability value");
                break;
              }
              requireInRange(value, 0, 1, "stability");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, stability: value },
              };
            }
            break;
          case "similarity":
          case "similarityboost":
          case "similarity_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid similarityBoost value");
                break;
              }
              requireInRange(value, 0, 1, "similarityBoost");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, similarityBoost: value },
              };
            }
            break;
          case "style":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid style value");
                break;
              }
              requireInRange(value, 0, 1, "style");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, style: value },
              };
            }
            break;
          case "speed":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid speed value");
                break;
              }
              requireInRange(value, 0.5, 2, "speed");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, speed: value },
              };
            }
            break;
          case "speakerboost":
          case "speaker_boost":
          case "usespeakerboost":
          case "use_speaker_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseBooleanValue(rawValue);
              if (value == null) {
                warnings.push("invalid useSpeakerBoost value");
                break;
              }
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, useSpeakerBoost: value },
              };
            }
            break;
          case "normalize":
          case "applytextnormalization":
          case "apply_text_normalization":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              applyTextNormalization: normalizeApplyTextNormalization(rawValue),
            };
            break;
          case "language":
          case "languagecode":
          case "language_code":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              languageCode: normalizeLanguageCode(rawValue),
            };
            break;
          case "seed":
            if (!policy.allowSeed) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              seed: normalizeSeed(Number.parseInt(rawValue, 10)),
            };
            break;
          default:
            break;
        }
      } catch (err) {
        warnings.push((err as Error).message);
      }
    }
    return "";
  });

  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}

/**
 * `gpt-realtime-2.1-mini` speaks through the Realtime API (see openai-realtime-tts.ts). The
 * other three are the `/v1/audio/speech` models OpenAI shuts down on 2027-01-06; they stay
 * selectable until then and are upgraded automatically once the API rejects them.
 */
export const OPENAI_LEGACY_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
export const OPENAI_TTS_MODELS = [
  ...OPENAI_REALTIME_TTS_MODELS,
  ...OPENAI_LEGACY_TTS_MODELS,
] as const;
export const DEFAULT_OPENAI_TTS_MODEL = OPENAI_REALTIME_TTS_MODELS[0];

const ttsLog = createSubsystemLogger("tts/openai");

/** OpenAI's announced shutdown date for the `/v1/audio/speech` models. */
export const OPENAI_LEGACY_TTS_SHUTDOWN_MS = Date.UTC(2027, 0, 6);

/**
 * True for the API's "this model has been shut down" answer, as opposed to any other bad
 * request. A bare "model not found" is ambiguous before the shutdown date (a project whose
 * model allowlist excludes the model gets the same answer), so until then only an explicit
 * retirement notice counts.
 */
export function isRetiredModelResponse(status: number, body: string, now = Date.now()): boolean {
  if (status !== 400 && status !== 404 && status !== 410) {
    return false;
  }
  if (!/model/i.test(body)) {
    return false;
  }
  if (/deprecat|retired|shut ?down|no longer (available|supported)/i.test(body)) {
    return true;
  }
  return now >= OPENAI_LEGACY_TTS_SHUTDOWN_MS && /model_not_found|does not exist/i.test(body);
}

/** Legacy models the API has already reported retired; later calls skip the doomed request. */
const retiredOpenAiTtsModels = new Set<string>();
const warnedVoiceSubstitutions = new Set<string>();

/** Test hook: forget learned retirements and one-time warnings. */
export function resetOpenAiTtsStateForTest(): void {
  retiredOpenAiTtsModels.clear();
  warnedVoiceSubstitutions.clear();
}

/**
 * Custom OpenAI-compatible TTS endpoint.
 * When set, model/voice validation is relaxed to allow non-OpenAI models.
 * Example: OPENAI_TTS_BASE_URL=http://localhost:8880/v1
 *
 * Note: Read at runtime (not module load) to support config.env loading.
 */
function getOpenAITtsBaseUrl(): string {
  return (process.env.OPENAI_TTS_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
}

function isCustomOpenAIEndpoint(): boolean {
  return getOpenAITtsBaseUrl() !== "https://api.openai.com/v1";
}
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

export function isValidOpenAIModel(model: string): boolean {
  // Allow any model when using custom endpoint (e.g., Kokoro, LocalAI)
  if (isCustomOpenAIEndpoint()) {
    return true;
  }
  return OPENAI_TTS_MODELS.includes(model as (typeof OPENAI_TTS_MODELS)[number]);
}

export function isValidOpenAIVoice(voice: string): voice is OpenAiTtsVoice {
  // Allow any voice when using custom endpoint (e.g., Kokoro Chinese voices)
  if (isCustomOpenAIEndpoint()) {
    return true;
  }
  return OPENAI_TTS_VOICES.includes(voice as OpenAiTtsVoice);
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

function resolveSummaryModelRef(
  cfg: BitterbotConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = config.summaryModel?.trim();
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

export async function summarizeText(params: {
  text: string;
  targetLength: number;
  cfg: BitterbotConfig;
  config: ResolvedTtsConfig;
  timeoutMs: number;
}): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // PLAN-50: attributed completion records usage under tts/summary and surfaces the real
      // provider error instead of masking it.
      const { completeAttributed } = await import("../agents/complete-attributed.js");
      const { message } = await completeAttributed({
        provider: ref.provider,
        modelId: ref.model,
        cfg,
        messages: [
          {
            role: "user",
            content:
              `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
              `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
              `Reply only with the summary, without additional explanations.\n\n` +
              `<text_to_summarize>\n${text}\n</text_to_summarize>`,
            timestamp: Date.now(),
          },
        ],
        maxTokens: Math.ceil(targetLength / 2),
        signal: controller.signal,
        feature: "tts/summary",
        errorPrefix: "summary",
        ignoreBudget: true,
        // A missing key fails fast with the provider name, as before.
        requireApiKey: true,
      });

      const summary = message.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!summary) {
        throw new Error("No summary returned");
      }

      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}

export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}

export async function elevenLabsTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  voiceSettings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"];
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    voiceSettings,
    timeoutMs,
  } = params;
  if (!isValidVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);

  const synthStartedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`${normalizeElevenLabsBaseUrl(baseUrl)}/v1/text-to-speech/${voiceId}`);
    if (outputFormat) {
      url.searchParams.set("output_format", outputFormat);
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        seed: normalizedSeed,
        apply_text_normalization: normalizedNormalization,
        language_code: normalizedLanguage,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    // PLAN-50 Phase 5: ElevenLabs bills per character on a subscription; recorded, unpriced.
    recordUsage({
      kind: "tts",
      feature: USAGE_FEATURES.ttsSynthesis,
      provider: "elevenlabs",
      model: modelId,
      usage: { input: text.length, total: text.length },
      items: text.length,
      durationMs: Date.now() - synthStartedAt,
    });
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function openaiTTS(params: {
  text: string;
  apiKey: string;
  model: string;
  voice: string;
  responseFormat: "mp3" | "opus" | "pcm";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, model, voice, responseFormat, timeoutMs } = params;

  if (!isValidOpenAIModel(model)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const synthStartedAt = Date.now();

  const custom = isCustomOpenAIEndpoint();

  const speakRealtime = async (realtimeModel: string, budgetMs: number): Promise<Buffer> => {
    const realtimeVoice = resolveOpenAIRealtimeVoice(voice);
    if (realtimeVoice && realtimeVoice !== voice && !warnedVoiceSubstitutions.has(voice)) {
      warnedVoiceSubstitutions.add(voice);
      ttsLog.warn(
        `OpenAI voice "${voice}" does not exist on ${realtimeModel}; using "${realtimeVoice}". Set messages.tts.openai.voice to choose another.`,
      );
    }
    const { audio } = await openaiRealtimeTTS(
      {
        text,
        apiKey,
        model: realtimeModel,
        voice,
        responseFormat,
        // Streamed generation scales with length; do not let a short timeout doom long text.
        timeoutMs: Math.max(budgetMs, realtimeSpeechBudgetMs(text.length)),
      },
      {
        // Every completed session is billed, including one whose audio is rejected, so each
        // gets its own row. `tts` rows keep CHARACTERS in `input` so all speech providers
        // compare on one unit; the session's output tokens ride along for reference.
        onSession: (usage) =>
          recordUsage({
            kind: "tts",
            feature: USAGE_FEATURES.ttsSynthesis,
            provider: "openai",
            model: realtimeModel,
            usage: { input: text.length, output: usage.outputTokens, total: text.length },
            items: text.length,
            durationMs: Date.now() - synthStartedAt,
          }),
      },
    );
    return audio;
  };

  // Which model goes to /audio/speech, if any.
  let httpModel = model;
  if (custom) {
    // Custom endpoints (Kokoro, LocalAI) only speak the HTTP speech API and do not know the
    // realtime model name; keep sending them the name they were sent before it was default.
    if (isOpenAIRealtimeTtsModel(model)) {
      httpModel = OPENAI_LEGACY_TTS_MODELS[0];
    }
  } else if (isOpenAIRealtimeTtsModel(model)) {
    const legacyFallback = OPENAI_LEGACY_TTS_MODELS[0];
    if (isOpenAIRealtimeTtsVoice(voice) || retiredOpenAiTtsModels.has(legacyFallback)) {
      return await speakRealtime(model, timeoutMs);
    }
    // The configured voice only exists on the old models. Keep that exact voice for as long
    // as OpenAI serves them; after the shutdown the retired branch below takes over.
    httpModel = legacyFallback;
  } else if (retiredOpenAiTtsModels.has(model)) {
    return await speakRealtime(DEFAULT_OPENAI_TTS_MODEL, timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${getOpenAITtsBaseUrl()}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: httpModel,
        input: text,
        voice,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const remainingMs = timeoutMs - (Date.now() - synthStartedAt);
      if (
        !custom &&
        isRetiredModelResponse(response.status, body) &&
        resolveOpenAIRealtimeVoice(voice) &&
        remainingMs > 1000
      ) {
        // The model has been shut down. Keep speech working on its replacement instead of
        // failing every reply until the operator edits config, and remember it so later
        // replies skip the doomed request.
        retiredOpenAiTtsModels.add(httpModel);
        ttsLog.warn(
          `OpenAI rejected TTS model ${httpModel} as retired (${response.status}); using ${DEFAULT_OPENAI_TTS_MODEL} from now on. Set messages.tts.openai.model to silence this.`,
        );
        return await speakRealtime(DEFAULT_OPENAI_TTS_MODEL, remainingMs);
      }
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }

    // PLAN-50 Phase 5: speech is billed per character; `input` holds characters for tts rows.
    recordUsage({
      kind: "tts",
      feature: USAGE_FEATURES.ttsSynthesis,
      provider: "openai",
      model: httpModel,
      usage: { input: text.length, total: text.length },
      items: text.length,
      durationMs: Date.now() - synthStartedAt,
    });
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export function inferEdgeExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("webm")) {
    return ".webm";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

export async function edgeTTS(params: {
  text: string;
  outputPath: string;
  config: ResolvedTtsConfig["edge"];
  timeoutMs: number;
}): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;
  const tts = new EdgeTTS({
    voice: config.voice,
    lang: config.lang,
    outputFormat: config.outputFormat,
    saveSubtitles: config.saveSubtitles,
    proxy: config.proxy,
    rate: config.rate,
    pitch: config.pitch,
    volume: config.volume,
    timeout: config.timeoutMs ?? timeoutMs,
  });
  await tts.ttsPromise(text, outputPath);
}
