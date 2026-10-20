import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "../../media-understanding/runner.js";
import { textToSpeech } from "../../tts/tts.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkConfigParams,
  validateTalkModeParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function normalizeTalkConfigSection(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const talk: Record<string, unknown> = {};
  if (typeof source.voiceId === "string") {
    talk.voiceId = source.voiceId;
  }
  if (
    source.voiceAliases &&
    typeof source.voiceAliases === "object" &&
    !Array.isArray(source.voiceAliases)
  ) {
    const aliases: Record<string, string> = {};
    for (const [alias, id] of Object.entries(source.voiceAliases as Record<string, unknown>)) {
      if (typeof id !== "string") {
        continue;
      }
      aliases[alias] = id;
    }
    if (Object.keys(aliases).length > 0) {
      talk.voiceAliases = aliases;
    }
  }
  if (typeof source.modelId === "string") {
    talk.modelId = source.modelId;
  }
  if (typeof source.outputFormat === "string") {
    talk.outputFormat = source.outputFormat;
  }
  if (typeof source.apiKey === "string") {
    talk.apiKey = source.apiKey;
  }
  if (typeof source.interruptOnSpeech === "boolean") {
    talk.interruptOnSpeech = source.interruptOnSpeech;
  }
  return Object.keys(talk).length > 0 ? talk : undefined;
}

/** About two minutes of Opus at voice bitrates; a turn, not a recording. */
const MAX_TALK_AUDIO_BYTES = 8 * 1024 * 1024;

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
};

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const configPayload: Record<string, unknown> = {};

    const talkSource = includeSecrets
      ? snapshot.config.talk
      : redactConfigObject(snapshot.config.talk);
    const talk = normalizeTalkConfigSection(talkSource);
    if (talk) {
      configPayload.talk = talk;
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  // Talk mode is no longer only for a phone node: the Control UI talks too
  // (PLAN-53 F3), so the mobile-node guard is gone.
  /**
   * One spoken turn to text (PLAN-53 F3), through the same transcription
   * providers as voice notes from chat apps.
   */
  "talk.transcribe": async ({ params, respond }) => {
    const audio = typeof params.audio === "string" ? params.audio : "";
    const mimeType = (typeof params.mimeType === "string" ? params.mimeType : "audio/webm")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const ext = AUDIO_EXT[mimeType];
    if (!audio || !ext) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.transcribe needs base64 audio of a known type",
        ),
      );
      return;
    }
    const bytes = Buffer.from(audio, "base64");
    if (bytes.length === 0 || bytes.length > MAX_TALK_AUDIO_BYTES) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "audio is empty or too long"),
      );
      return;
    }
    const dir = path.join(resolveStateDir(), "tmp", "talk");
    const file = path.join(dir, `${crypto.randomUUID()}${ext}`);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, bytes, { mode: 0o600 });
      const cfg = loadConfig();
      const ctx: MsgContext = { MediaPath: file, MediaType: mimeType };
      const media = normalizeMediaAttachments(ctx);
      const cache = createMediaAttachmentCache(media);
      try {
        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry: buildProviderRegistry(),
        });
        const text = result.outputs.find((o) => o.kind === "audio.transcription")?.text?.trim();
        if (!text) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              result.decision.outcome === "success"
                ? "no speech was recognized"
                : "speech to text is not available: add an OpenAI, Groq, Deepgram or Google key, or configure tools.media.audio",
            ),
          );
          return;
        }
        respond(true, { text });
      } finally {
        await cache.cleanup();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    } finally {
      await fs.rm(file, { force: true });
    }
  },

  /** Text to speech for the Control UI, returned as audio bytes (PLAN-53 F3). */
  "talk.speak": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak needs text"));
      return;
    }
    try {
      const result = await textToSpeech({ text, cfg: loadConfig() });
      if (!result.success || !result.audioPath) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "text to speech failed"),
        );
        return;
      }
      try {
        const data = await fs.readFile(result.audioPath);
        respond(true, {
          audio: data.toString("base64"),
          mimeType: AUDIO_MIME[path.extname(result.audioPath).toLowerCase()] ?? "audio/mpeg",
          provider: result.provider,
        });
      } finally {
        await fs.rm(result.audioPath, { force: true });
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "talk.mode": ({ params, respond, context }) => {
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
