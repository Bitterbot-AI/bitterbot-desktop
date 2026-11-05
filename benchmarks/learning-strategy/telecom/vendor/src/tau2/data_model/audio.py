import base64
from enum import Enum
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field, computed_field

from tau2.config import DEFAULT_PCM_SAMPLE_RATE, DEFAULT_TELEPHONY_RATE

# Standard sample rates (sourced from config.py - single source of truth)
TELEPHONY_SAMPLE_RATE = DEFAULT_TELEPHONY_RATE
PCM_SAMPLE_RATE = DEFAULT_PCM_SAMPLE_RATE


def audio_bytes_to_string(data: bytes) -> str:
    """Convert audio bytes to base64 string."""
    return base64.b64encode(data).decode("ascii")


def audio_string_to_bytes(data: str) -> bytes:
    """Convert base64 string to audio bytes."""
    return base64.b64decode(data.encode("ascii"))


class AudioEncoding(str, Enum):
    """Audio encoding format.

    Companded formats (always 8-bit / 1 byte per sample):
        - ULAW: μ-law companding (telephony, NA/Japan)
        - ALAW: A-law companding (telephony, Europe/International)

    Linear PCM formats (little-endian):
        - PCM_U8: 8-bit unsigned PCM (1 byte per sample) - WAV standard for 8-bit
        - PCM_S16LE: 16-bit signed PCM (2 bytes per sample) - most common
        - PCM_S24LE: 24-bit signed PCM (3 bytes per sample)
        - PCM_S32LE: 32-bit signed PCM (4 bytes per sample)
    """

    # Companded formats (8-bit)
    ULAW = "ulaw"
    ALAW = "alaw"

    # Linear PCM formats with explicit bit depth
    PCM_U8 = "pcm_u8"  # Unsigned 8-bit (WAV standard for 8-bit)
    PCM_S16LE = "pcm_s16le"
    PCM_S24LE = "pcm_s24le"
    PCM_S32LE = "pcm_s32le"

    @property
    def sample_width(self) -> int:
        """Return the sample width in bytes for this encoding."""
        return _ENCODING_SAMPLE_WIDTH[self]

    @property
    def bits_per_sample(self) -> int:
        """Return the bits per sample for this encoding."""
        return self.sample_width * 8

    @property
    def is_companded(self) -> bool:
        """Return True if this is a companded format (ulaw/alaw)."""
        return self in (AudioEncoding.ULAW, AudioEncoding.ALAW)

    @property
    def is_linear_pcm(self) -> bool:
        """Return True if this is a linear PCM format."""
        return not self.is_companded


# Mapping from encoding to sample width in bytes
_ENCODING_SAMPLE_WIDTH: dict[AudioEncoding, int] = {
    AudioEncoding.ULAW: 1,
    AudioEncoding.ALAW: 1,
    AudioEncoding.PCM_U8: 1,
    AudioEncoding.PCM_S16LE: 2,
    AudioEncoding.PCM_S24LE: 3,
    AudioEncoding.PCM_S32LE: 4,
}


class AudioFormat(BaseModel):
    """Audio format metadata describing how to interpret raw audio bytes.

    The sample_width is derived from the encoding - no need to specify it separately.

    Examples:
        AudioFormat(encoding=AudioEncoding.ULAW, sample_rate=8000)  # 8-bit, 8kHz
        AudioFormat(encoding=AudioEncoding.PCM_S16LE, sample_rate=16000)  # 16-bit, 16kHz
        AudioFormat(encoding=AudioEncoding.PCM_S16LE, sample_rate=44100, channels=2)  # stereo CD
    """

    encoding: AudioEncoding = Field(
        default=AudioEncoding.ULAW,
        description="Audio encoding format (determines sample width)",
    )
    sample_rate: int = Field(
        default=8000,
        description="Sample rate in Hz (e.g., 8000 for telephony, 16000 for wideband, 44100 for CD quality)",
    )
    channels: Literal[1, 2] = Field(
        default=1,
        description="Number of audio channels (1 for mono, 2 for stereo)",
    )

    def __str__(self) -> str:
        """Human-readable format description."""
        channel_str = "mono" if self.channels == 1 else "stereo"
        return f"{self.encoding.value}, {self.sample_rate} Hz, {self.bits_per_sample}-bit, {channel_str}"

    @computed_field  # type: ignore[misc]
    @property
    def sample_width(self) -> int:
        """Sample width in bytes (derived from encoding)."""
        return self.encoding.sample_width

    @computed_field  # type: ignore[misc]
    @property
    def bits_per_sample(self) -> int:
        """Bits per sample (derived from encoding)."""
        return self.encoding.bits_per_sample

    @computed_field  # type: ignore[misc]
    @property
    def bytes_per_sample(self) -> int:
        """Bytes per sample (sample_width * channels)."""
        return self.sample_width * self.channels

    @property
    def is_pcm16(self) -> bool:
        """Return True if this is 16-bit PCM format."""
        return self.encoding == AudioEncoding.PCM_S16LE

    @property
    def is_ulaw(self) -> bool:
        """Return True if this is μ-law format."""
        return self.encoding == AudioEncoding.ULAW

    @property
    def is_alaw(self) -> bool:
        """Return True if this is A-law format."""
        return self.encoding == AudioEncoding.ALAW

    @property
    def bytes_per_second(self) -> int:
        """Bytes per second for this format (sample_rate * bytes_per_sample)."""
        return self.sample_rate * self.bytes_per_sample


class AudioData(BaseModel):
    """Audio data in bytes with format metadata."""

    data: bytes = Field(description="Audio data in bytes")
    format: AudioFormat = Field(description="Audio format metadata")
    audio_path: Optional[Path] = Field(
        default=None, description="Path to the generated audio file"
    )

    @computed_field  # type: ignore[misc]
    @property
    def num_samples(self) -> int:
        """Number of samples.

        Formula: num_samples = num_bytes / (sample_width * channels)
        """
        return len(self.data) // self.format.bytes_per_sample

    @computed_field  # type: ignore[misc]
    @property
    def duration(self) -> float:
        """
        Calculate duration of the audio in seconds from the raw bytes and format metadata.

        Formula: duration = num_samples / sample_rate

        Example for μ-law (8-bit, 8000 Hz, mono):
        - 8000 samples / 8000 Hz = 1.0 second
        """
        return self.num_samples / self.format.sample_rate


# Default audio format for telephony (8kHz μ-law, mono)
# This is the standard format for OpenAI Realtime API in telephony mode
TELEPHONY_AUDIO_FORMAT = AudioFormat(
    encoding=AudioEncoding.ULAW,
    sample_rate=TELEPHONY_SAMPLE_RATE,
    channels=1,
)
