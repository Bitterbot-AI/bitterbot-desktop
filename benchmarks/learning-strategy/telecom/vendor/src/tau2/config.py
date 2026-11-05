# =============================================================================
# SIMULATION DEFAULTS (overridable via CLI)
# =============================================================================
DEFAULT_MAX_STEPS = 200
DEFAULT_MAX_ERRORS = 10
DEFAULT_SEED = 300
DEFAULT_TASK_SUBSET_SIZE = 50
DEFAULT_TASK_SUBSET_SEED = 42
DEFAULT_MAX_CONCURRENCY = 3
DEFAULT_JUDGE_PROCESSES = 1
DEFAULT_JUDGE_CONCURRENCY = 1
DEFAULT_NUM_TRIALS = 1
DEFAULT_SAVE_TO = None
DEFAULT_LOG_LEVEL = "ERROR"
DEFAULT_LOCALIZE_DB = True
# Scenarios, policies and simulator guidelines are authored in this language.
SCENARIO_LANGUAGE = "en"
# Every run resolves a language pack; without --language it is canonical English.
DEFAULT_LANGUAGE = "en"

# =============================================================================
# LLM DEFAULTS (overridable via CLI)
# =============================================================================
DEFAULT_AGENT_IMPLEMENTATION = "llm_agent"
DEFAULT_USER_IMPLEMENTATION = "user_simulator"
DEFAULT_LLM_AGENT = "gpt-4.1-2025-04-14"
DEFAULT_LLM_USER = "gpt-4.1-2025-04-14"
DEFAULT_LLM_TEMPERATURE_AGENT = 0.0
DEFAULT_LLM_TEMPERATURE_USER = 0.0
DEFAULT_LLM_ARGS_AGENT = {"temperature": DEFAULT_LLM_TEMPERATURE_AGENT}
DEFAULT_LLM_ARGS_USER = {"temperature": DEFAULT_LLM_TEMPERATURE_USER}

# English elicitation defaults. Other domains retain the defaults above.
ELICITATION_DOMAINS = frozenset({"intake"})
# Retrieval config for banking_knowledge runs that do not choose one; the
# released banking benchmark requires it.
DEFAULT_BANKING_RETRIEVAL_CONFIG = "alltools"
DEFAULT_ELICITATION_STRATEGY = "agent_directed"
DEFAULT_ELICITATION_COMPLICATION_RATE = 1.0
DEFAULT_ELICITATION_MAX_STEPS_SECONDS = 240
DEFAULT_ELICITATION_LLM_USER = "gpt-5.5"
DEFAULT_ELICITATION_LLM_ARGS_USER = {"temperature": 0.0, "reasoning_effort": "low"}
DEFAULT_INTAKE_TASK_SEED = 20260824

DEFAULT_LLM_NL_ASSERTIONS = "gpt-5.4-mini-2026-03-17"
DEFAULT_LLM_NL_ASSERTIONS_ARGS = {"reasoning_effort": "low"}

DEFAULT_LLM_ENV_INTERFACE = "gpt-4.1-2025-04-14"
DEFAULT_LLM_ENV_INTERFACE_TEMPERATURE = 0.0
DEFAULT_LLM_ENV_INTERFACE_ARGS = {"temperature": DEFAULT_LLM_ENV_INTERFACE_TEMPERATURE}

# Semantic communication scoring for every run; independent of the customer model.
DEFAULT_SEMANTIC_COMMUNICATE_MODEL = "gpt-5.5"
DEFAULT_SEMANTIC_COMMUNICATE_MODEL_ARGS = {"reasoning_effort": "low"}

DEFAULT_LLM_EVAL_USER_SIMULATOR = "claude-opus-4-5"

# LLM debug logging
DEFAULT_LLM_LOG_MODE = "latest"  # Options: "all", "latest"

# =============================================================================
# LLM INFRASTRUCTURE (fixed operational constants)
# =============================================================================
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_MIN_WAIT = 1.0  # seconds
DEFAULT_RETRY_MAX_WAIT = 10.0  # seconds
DEFAULT_RETRY_MULTIPLIER = 1.0  # exponential backoff multiplier

# LiteLLM cache
LLM_CACHE_ENABLED = False
DEFAULT_LLM_CACHE_TYPE = "redis"

# Redis (fixed infrastructure config)
REDIS_HOST = "localhost"
REDIS_PORT = 6379
REDIS_PASSWORD = ""
REDIS_PREFIX = "tau2"
REDIS_CACHE_VERSION = "v1"
REDIS_CACHE_TTL = 60 * 60 * 24 * 30

# Langfuse
USE_LANGFUSE = False

# =============================================================================
# API SERVICE (fixed)
# =============================================================================
API_PORT = 8000

# =============================================================================
# AUDIO CONSTANTS (fixed, protocol-defined)
# =============================================================================
DEFAULT_PCM_SAMPLE_RATE = 16000  # User simulator synthesis rate
DEFAULT_TELEPHONY_RATE = 8000  # API/agent rate (8kHz μ-law, 1 byte/sample)
TELEPHONY_ULAW_SILENCE = b"\x7f"  # μ-law silence byte

# =============================================================================
# VOICE DEFAULTS (overridable via CLI, legacy half-duplex mode)
# =============================================================================
DEFAULT_VOICE_ENABLED = False
DEFAULT_VOICE_SYNTHESIS_PROVIDER = "elevenlabs"
DEFAULT_VOICE_TRANSCRIPTION_MODEL = "nova-3"
DEFAULT_VOICE_MODEL = "eleven_v3"

# Text streaming (legacy)
DEFAULT_TEXT_STREAMING_CHUNK_BY = "words"
DEFAULT_TEXT_STREAMING_CHUNK_SIZE = 1
DEFAULT_TEXT_STREAMING_CONFIG = {
    "chunk_by": DEFAULT_TEXT_STREAMING_CHUNK_BY,
    "chunk_size": DEFAULT_TEXT_STREAMING_CHUNK_SIZE,
}

# =============================================================================
# VOICE USER SIMULATOR (fixed versioning + overridable model)
# =============================================================================
VOICE_USER_SIMULATOR_VERSION = "v1.1"  # fixed, bump on changes
VOICE_USER_SIMULATOR_DECISION_MODEL = "gpt-5.4-mini-2026-03-17"  # overridable
VOICE_USER_SIMULATOR_DECISION_MODEL_ARGS = {"reasoning_effort": "low"}
DEFAULT_SPEECH_COMPLEXITY = "regular"  # overridable: "control", "regular"
DEFAULT_CHANNEL_EFFECTS_MODE = "regular"
DEFAULT_SPEECH_EFFECTS_MODE = "regular"

# =============================================================================
# FULL-DUPLEX VOICE DEFAULTS (overridable via CLI)
# =============================================================================
DEFAULT_AUDIO_NATIVE_AGENT_IMPLEMENTATION = "discrete_time_audio_native_agent"
DEFAULT_AUDIO_NATIVE_USER_IMPLEMENTATION = "voice_streaming_user_simulator"
DEFAULT_AUDIO_NATIVE_PROVIDER = (
    "openai"  # overridable: openai, openai_live, gemini, xai, nova, qwen, livekit
)
DEFAULT_TICK_DURATION_SECONDS = 0.20  # overridable
DEFAULT_MAX_STEPS_SECONDS = 1200  # overridable
DEFAULT_SEND_AUDIO_INSTANT = False  # overridable

# Turn-taking thresholds (overridable, in seconds, converted to ticks at runtime)
DEFAULT_WAIT_TO_RESPOND_THRESHOLD_OTHER_SECONDS = 1.0
DEFAULT_WAIT_TO_RESPOND_THRESHOLD_SELF_SECONDS = 5.0
DEFAULT_YIELD_THRESHOLD_WHEN_INTERRUPTED_SECONDS = 1.0
DEFAULT_YIELD_THRESHOLD_WHEN_INTERRUPTING_SECONDS = 5.0
DEFAULT_INTERRUPTION_CHECK_INTERVAL_SECONDS = 2.0
DEFAULT_INTEGRATION_DURATION_SECONDS = 0.5
DEFAULT_SILENCE_ANNOTATION_THRESHOLD_SECONDS = 4.0
DEFAULT_BACKCHANNEL_MIN_THRESHOLD_SECONDS = 3.0
DEFAULT_BACKCHANNEL_MAX_THRESHOLD_SECONDS = 12.0
DEFAULT_BACKCHANNEL_POISSON_RATE = 1.0 / 10.0
DEFAULT_USE_LLM_BACKCHANNEL = True

# Retry (overridable)
DEFAULT_AUDIO_NATIVE_MAX_RETRIES = 3
DEFAULT_AUDIO_NATIVE_RETRY_DELAY_SECONDS = 5.0

# =============================================================================
# ADAPTER TIMING (fixed operational constants)
# =============================================================================
DEFAULT_AUDIO_NATIVE_VOIP_PACKET_INTERVAL_MS = 20  # fixed, standard RTP pacing
DEFAULT_AUDIO_NATIVE_CONNECT_TIMEOUT = 30.0  # fixed
DEFAULT_AUDIO_NATIVE_DISCONNECT_TIMEOUT = 5.0  # fixed
DEFAULT_AUDIO_NATIVE_THREAD_JOIN_TIMEOUT = 2.0  # fixed
DEFAULT_AUDIO_NATIVE_TICK_TIMEOUT_BUFFER = 30.0  # fixed
DEFAULT_AUDIO_NATIVE_MAX_INACTIVE_SECONDS = 40.0  # fixed, stall detection

# =============================================================================
# OPENAI PROVIDER (overridable model/voice, fixed API constants)
# =============================================================================
DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-1.5"  # overridable
DEFAULT_OPENAI_LIVE_MODEL = "gpt-live-1"  # overridable
_LEGACY_OPENAI_REALTIME_MODEL = "gpt-realtime-2025-08-28"
DEFAULT_OPENAI_REALTIME_BASE_URL = "wss://api.openai.com/v1/realtime"  # fixed
DEFAULT_OPENAI_VOICE = "alloy"  # overridable
DEFAULT_OPENAI_NOISE_REDUCTION = "near_field"  # fixed: "near_field", "far_field", None
DEFAULT_OPENAI_VAD_THRESHOLD_LOW = 0.2  # fixed
DEFAULT_OPENAI_VAD_THRESHOLD_DEFAULT = 0.5  # fixed
DEFAULT_OPENAI_VAD_THRESHOLD = DEFAULT_OPENAI_VAD_THRESHOLD_DEFAULT
DEFAULT_OPENAI_OUTPUT_SAMPLE_RATE = 24000  # fixed, API-defined
DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"  # overridable
DEFAULT_WHISPER_MODEL = "whisper-1"  # fixed

# =============================================================================
# GEMINI PROVIDER (overridable model/voice, fixed API constants)
# =============================================================================
# Auth mode selected from environment:
#   GEMINI_API_KEY -> AI Studio
#   GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS -> Vertex AI
DEFAULT_GEMINI_MODEL = "gemini-3.8-live-extended-thinking"  # overridable
_LEGACY_GEMINI_MODEL = "gemini-live-2.5-flash-native-audio"
DEFAULT_GEMINI_VOICE = "Zephyr"  # overridable
DEFAULT_GEMINI_PROACTIVE_AUDIO = True  # fixed
DEFAULT_GEMINI_LOCATION = "us-central1"  # fixed
DEFAULT_GEMINI_INPUT_SAMPLE_RATE = 8000  # fixed, API-defined
DEFAULT_GEMINI_OUTPUT_SAMPLE_RATE = 24000  # fixed, API-defined
DEFAULT_GEMINI_TRANSCRIPTION_LANGUAGE_CODES = ["en-US"]  # overridable

# =============================================================================
# XAI PROVIDER (overridable model/voice, fixed API constants)
# =============================================================================
DEFAULT_XAI_REALTIME_BASE_URL = "wss://api.x.ai/v1/realtime"  # fixed
DEFAULT_XAI_VOICE = "ara"  # overridable; lowercase voice IDs (ara, rex, sal, eve, leo)
# Model is selected via ?model= query param on the WebSocket URL.
# Aliases: grok-voice-latest -> grok-voice-think-fast-2.0 (since 2026-08-05).
# Reasoning: session.update reasoning.effort accepts "high" | "none"
# (API default "high").
DEFAULT_XAI_MODEL = "grok-voice-think-fast-2.0"  # overridable

# =============================================================================
# NOVA PROVIDER (overridable model/voice, fixed API constants)
# =============================================================================
DEFAULT_NOVA_MODEL = "amazon.nova-2-sonic-v1:0"  # overridable
DEFAULT_NOVA_VOICE = "tiffany"  # overridable: matthew, tiffany, amy
DEFAULT_NOVA_REGION = "us-east-1"  # fixed
DEFAULT_NOVA_INPUT_SAMPLE_RATE = 16000  # fixed, API-defined
DEFAULT_NOVA_OUTPUT_SAMPLE_RATE = 24000  # fixed, API-defined

# =============================================================================
# QWEN PROVIDER (overridable model/voice, fixed API constants)
# =============================================================================
DEFAULT_QWEN_REALTIME_URL = (
    "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime"  # fixed
)
# Qwen3.5-Omni realtime models support tool calling over WebSocket
# (the older qwen3-omni-flash-realtime accepted tool configs but never
# invoked them). Flash variant: qwen3.5-omni-flash-realtime.
# Rate limits:
# qwen3.5-omni-plus-realtime; 60 (requests per minute); 100,000 (tokens per minute)
# qwen3.5-omni-plus-realtime-2026-03-15; 60 (requests per minute); 100,000 (tokens per minute)
DEFAULT_QWEN_MODEL = "qwen3.5-omni-plus-realtime"  # overridable
DEFAULT_QWEN_VOICE = "Tina"  # overridable; Qwen3.5-Omni-Realtime default voice
DEFAULT_QWEN_INPUT_SAMPLE_RATE = 16000  # fixed, API-defined
DEFAULT_QWEN_OUTPUT_SAMPLE_RATE = 24000  # fixed, API-defined

# Explicit-language cascaded runs use the same speech models and voice in every
# language. Flash supports language hints; Multilingual V2 does not.
DEFAULT_CASCADED_MULTILINGUAL_STT_MODEL = "nova-3"
DEFAULT_CASCADED_MULTILINGUAL_TTS_MODEL = "eleven_flash_v2_5"
DEFAULT_CASCADED_MULTILINGUAL_VOICE_ID = "9BWtsMINqrJLrRacOk9x"  # Aria
DEFAULT_CASCADED_TTS_SAMPLE_RATE = 24000

# =============================================================================
# PROVIDER REGISTRY (derived from above)
# =============================================================================
DEFAULT_LAUNA_MODEL = "launa-v1"
LAUNA_SAMPLE_RATE = 24000  # fixed, both directions of the Launa voice API

DEFAULT_AUDIO_NATIVE_MODELS = {
    "launa": DEFAULT_LAUNA_MODEL,
    "openai": DEFAULT_OPENAI_REALTIME_MODEL,
    "openai_live": DEFAULT_OPENAI_LIVE_MODEL,
    "gemini": DEFAULT_GEMINI_MODEL,
    "xai": DEFAULT_XAI_MODEL,
    "nova": DEFAULT_NOVA_MODEL,
    "qwen": DEFAULT_QWEN_MODEL,
    "livekit": "dummy",
}

DEFAULT_AUDIO_NATIVE_REASONING_EFFORT: dict[str, str | None] = {
    "launa": None,
    "openai": None,
    "openai_live": None,
    "gemini": "high",
    "xai": "high",
    "nova": None,
    "qwen": None,
    "livekit": None,
}

AUDIO_NATIVE_PROVIDER_TYPES = {
    "launa": "audio_native",
    "openai": "audio_native",
    "openai_live": "audio_native",
    "gemini": "audio_native",
    "xai": "audio_native",
    "nova": "audio_native",
    "qwen": "audio_native",
    "livekit": "cascaded",
}

# =============================================================================
# DISPLAY
# =============================================================================
TERM_DARK_MODE = True

VOICE_INSTRUCTION_PROMPT_VERSION = "voice-instructions-v2"  # fixed prompt revision
SPELLING_NORMALIZATION_VERSION = "explicit-spelling-v1"

# Released benchmark conditions, supplied explicitly by benchmark entrypoints.
# Selecting a language alone does not select these run conditions. Voice runs
# default to the voice benchmark; text runs are custom unless `--benchmark text`.
DEFAULT_VOICE_BENCHMARK = "voice"
TEXT_BENCHMARK = "text"
DEFAULT_BENCHMARK_WORKERS = 1
DEFAULT_BENCHMARK_USER_MODEL = "openai/gpt-5.5"
DEFAULT_BENCHMARK_USER_ARGS = {"reasoning_effort": "low"}
DEFAULT_VOICE_BENCHMARK_MAX_STEPS_SECONDS = 2400
DEFAULT_VOICE_BENCHMARK_OPENAI_VOICE = "marin"

# Language factory authoring. These settings do not launch benchmark calls;
# every authoring request still pins its own model and reasoning effort.
DEFAULT_FACTORY_LOCALIZATION_BATCH_SIZE = 32
DEFAULT_FACTORY_LOCALIZATION_CONCURRENCY = 3
DATABASE_LOCALIZATION_PROSE_MAX_ENTRIES = 8
DATABASE_LOCALIZATION_PROSE_MAX_SOURCE_CHARACTERS = 12000

# Domain lookup behavior changes must not share benchmark condition fingerprints.
DOMAIN_TOOLS_VERSION = "speech-identity-v1"
