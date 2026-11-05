# Copyright Sierra
"""Voice configuration constants."""

from pathlib import Path
from typing import Optional

from tau2.utils.utils import DATA_DIR

# Data directories
DATA_DIR_VOICE = DATA_DIR / "voice"
BACKGROUND_NOISE_CONTINUOUS_DIR = (
    DATA_DIR_VOICE / "background_noise_audio_pcm_mono_verified" / "continuous"
)
BURST_NOISE_DIR = DATA_DIR_VOICE / "background_noise_audio_pcm_mono_verified" / "bursts"


def resolve_background_noise_path(filename: Optional[str]) -> Optional[Path]:
    """Resolve a background noise filename to its full path."""
    if filename is None:
        return None
    return BACKGROUND_NOISE_CONTINUOUS_DIR / filename


def resolve_burst_noise_paths(filenames: list[str]) -> list[Path]:
    """Resolve burst noise filenames to their full paths."""
    result = []
    for filename in filenames:
        result.append(BURST_NOISE_DIR / filename)
    return result


# Voice Synthesis & Transcription
DEFAULT_VOICE_SYNTHESIS_PROVIDER = "elevenlabs"
DEFAULT_TRANSCRIPTION_MODEL = "nova-3"
ASSUMED_TURNS_PER_MINUTE = 10
ELEVENLABS_ENABLE_AUDIO_TAGS = True
ELEVENLABS_AUDIO_TAGS_PROBABILITY = 0.1

# Streaming Chunks
CHUNK_DURATION_IN_SECONDS = 1
AUDIO_FREQUENCY = 8000
TEXT_NUM_WORDS_PER_SECOND = 2
AUDIO_CHUNK_SIZE_NUM_SAMPLES = AUDIO_FREQUENCY * CHUNK_DURATION_IN_SECONDS
TEXT_CHUNK_SIZE_NUM_WORDS = TEXT_NUM_WORDS_PER_SECOND * CHUNK_DURATION_IN_SECONDS
WAIT_TO_RESPOND_THRESHOLD_IN_SECONDS = 1
WAIT_TO_RESPOND_THRESHOLD_IN_CHUNKS = (
    WAIT_TO_RESPOND_THRESHOLD_IN_SECONDS // CHUNK_DURATION_IN_SECONDS
)
INTERRUPT_THRESHOLD_IN_SECONDS = 2
INTERRUPT_THRESHOLD_IN_CHUNKS = (
    INTERRUPT_THRESHOLD_IN_SECONDS // CHUNK_DURATION_IN_SECONDS
)
MAX_STEPS_IN_SECONDS = 60
MAX_STEPS = MAX_STEPS_IN_SECONDS // CHUNK_DURATION_IN_SECONDS

# Channel Effects - Frame Drops (Gilbert-Elliott model)
ENABLE_FRAME_DROPS = True
FRAME_DROP_RATE = 0.01  # Target loss rate (1%)
FRAME_DROP_BURST_DURATION_MS = 100  # Average burst duration in ms
FRAME_DROP_COUNT = 1
FRAME_DROP_DURATION_MS = 150  # Duration of each individual frame drop

# SNR Scaling
# Speech RMS level used as the reference for SNR-based noise/burst scaling.
# Noise is scaled so that noise_level / this_value = 10^(-SNR/20).
SNR_SPEECH_REFERENCE_RMS = 3000.0
MIN_RMS_THRESHOLD = 1e-6  # RMS floor to avoid division by zero / extreme scaling
MIN_BURST_RMS = 100.0  # Minimum burst RMS for SNR scaling to apply

# Audio Preprocessing
DEFAULT_FADE_OUT_SAMPLES = 100  # ~6ms at 16kHz, prevents clicking at chunk boundaries
NORMALIZE_RATIO = 0.75  # Normalization target for burst/overlay audio

# Telephony Conversion
TELEPHONY_LOW_FREQ = 300  # Hz, lower edge of telephony bandpass
TELEPHONY_HIGH_FREQ = 3400  # Hz, upper edge of telephony bandpass
TELEPHONY_HEADROOM = 0.9  # Scale factor to prevent clipping after filtering

# Muffling
CONSTANT_MUFFLE_CUTOFF_FREQ = (
    1000.0  # Cutoff for permanent muffling (speaker facing away)
)

# Source Effects
ENABLE_BACKGROUND_NOISE = True
NOISE_SNR_DB = 15.0
NOISE_SNR_DRIFT_DB = 3.0
NOISE_VARIATION_SPEED = 0.5
ENABLE_BURST_NOISE = True
BURST_NOISE_EVENTS_PER_MINUTE = 1.0
BURST_SNR_RANGE_DB = (-5.0, 10.0)  # Sample per burst from this range
ENABLE_DYNAMIC_MUFFLING = True
MUFFLE_PROBABILITY = 0.2
MUFFLE_SEGMENT_COUNT = 1
MUFFLE_SEGMENT_DURATION_MS = 500
MUFFLE_CUTOFF_FREQ = 1500.0
MUFFLE_TRANSITION_MS = 100

# Speech Inserts - Period prefix required for ElevenLabs to not treat audio tags as empty text
VOCAL_TICS = [
    ".[cough][cough][cough]",
    ".[sneeze][sneeze][sneeze]",
    ".[sniffle][sniffle][sniffle]",
]
NON_DIRECTED_PHRASES = [
    "Not now.",
    "Hold on a second.",
    "I'm on the phone.",
    "Just a minute.",
    "I don't know.",
    "Give me a moment.",
    "One second.",
    "I'll be right with you.",
    "Can you wait?",
    "Shh, quiet.",
]
ENABLE_OUT_OF_TURN_SPEECH = True
OUT_OF_TURN_SPEECH_EVENTS_PER_MINUTE = 0.7

# Speech Effects
ENABLE_VOCAL_TICS_DURING_SPEECH = True
VOCAL_TICS_DURING_SPEECH_PROBABILITY = 0.1
MIN_WORDS_FOR_VOCAL_TICS = 3
